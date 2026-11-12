import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { id, now } from './store.mjs';
import { BusinessStore } from './business-store.mjs';
import { inside } from './safety.mjs';
import { materialName, materialTarget } from './materials.mjs';
import { buildProjectContext } from './project-context.mjs';
import { checkNotePayload, inspectImage, normalizeNotePayload } from './business-modules/xiaohongshu.mjs';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const contentDigest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest('hex');
const refKinds = { project: 'projects', projects: 'projects', fact: 'projectFacts', projectFacts: 'projectFacts',
  work: 'workItems', workItem: 'workItems', workItems: 'workItems', content: 'contentRevisions',
  contentRevision: 'contentRevisions', contentRevisions: 'contentRevisions', asset: 'contentAssets', contentAssets: 'contentAssets',
  material: 'projectMaterials', projectMaterials: 'projectMaterials' };
const refMatches = (first, second) => (refKinds[first.kind] || first.kind) === (refKinds[second.kind] || second.kind) && first.id === second.id;
const terminalPublication = new Set(['published', 'revoked', 'expired', 'blocked', 'cancelled']);
const invalidMaterial = new Set(['invalid', 'revoked', 'superseded', 'deleted']);
export function reviewScopeDigest(revision) {
  const { schedule: _schedule, ...payload } = revision.manifest.payload;
  return contentDigest({ ...revision.manifest, payload, authorMemberIds: [...(revision.authorMemberIds || [])].sort() });
}
const sourceSchema = z.union([z.string().min(1).max(4000), z.object({}).passthrough()]);
const contentInputSchema = z.object({ title: z.string().max(200), body: z.string().max(20000),
  tags: z.array(z.string().max(100)).max(30).default([]), sources: z.array(sourceSchema).max(60).default([]),
  inputRefs: z.array(z.object({ kind: z.string().max(100), id: z.string().max(200), revision: z.number().optional(),
    generation: z.number().optional(), digest: z.string().max(128).optional() }).strict()).max(100).default([]),
  authorMemberIds: z.array(z.string().max(200)).max(20).default([]),
  images: z.array(z.any()).max(9), visibility: z.enum(['public', 'private']).default('public'),
  schedule: z.object({ kind: z.enum(['immediate', 'scheduled']), startsAt: z.string().datetime().optional() }).strict().default({ kind: 'immediate' }),
  changeSummary: z.string().max(3000).default('') }).strict();

/** Owns immutable bytes and manifests; mutable eligibility is deliberately a separate entity. */
export class ContentRevisionService {
  constructor({ store, dataDir, emit = () => {} }) {
    this.store = store; this.emit = emit; this.dataDir = path.resolve(dataDir);
    this.root = path.join(this.dataDir, 'business'); this.objectRoot = path.join(this.root, 'objects');
    this.attemptRoot = path.join(this.root, 'attempts');
    fs.mkdirSync(this.objectRoot, { recursive: true }); fs.mkdirSync(this.attemptRoot, { recursive: true });
    this.durable = new BusinessStore(store);
  }

  createItem(projectId, { title = '待制作图文', cycleId = null, requestId } = {}) {
    const create = () => {
      const project = this.store.get('projects', projectId);
      if (!project || project.status === 'archived') fail('业务项目不存在或已归档', 404);
      if (typeof title !== 'string' || !title || title.length > 200) fail('稿件名称无效', 400);
      if (cycleId && this.store.get('productionCycles', cycleId)?.projectId !== projectId) fail('生产周期不属于此项目', 400);
      const contentId = id('content');
      if (!this.durable.reserveContentSlot({ projectId, contentId, limit: project.limits?.maxPending || 3 })) fail('待批准与未决稿件已占满名额，请先处理已有稿件');
      const item = { id: contentId, projectId, cycleId, title, status: 'producing', generation: 1,
        currentRevisionId: null, currentDraftVersionId: null, currentReviewVersionId: null,
        createdAt: now(), updatedAt: now() };
      this.store.put('contentItems', item); this.emit('content.created', { projectId, contentId });
      return item;
    };
    return requestId ? this.durable.requestOnce(`content.create:${requestId}`, contentDigest({ projectId, title, cycleId }), create) : this.store.transaction(create);
  }

  requireItem(contentId) {
    const item = this.store.get('contentItems', contentId);
    if (!item) fail('稿件不存在', 404);
    return item;
  }

  resolveRef(projectId, ref) {
    const kind = refKinds[ref.kind];
    if (!kind) fail('工作输入类型未登记', 400);
    const value = this.store.get(kind, ref.id);
    if (!value || kind === 'projects' && value.id !== projectId || kind !== 'projects' && value.projectId && value.projectId !== projectId) fail('工作输入不存在或不属于此项目');
    if (ref.revision !== undefined && ref.revision !== (kind === 'projects' ? value.briefVersion : value.revision ?? value.generation)) fail('工作输入版本已变化');
    if (ref.generation !== undefined && ref.generation !== value.generation) fail('工作输入 generation 已变化');
    if (ref.digest && ref.digest !== (value.digest || value.manifestHash || value.outputDigest || value.resultDigest || value.sha256)) fail('工作输入摘要已变化');
    if (kind === 'projectFacts' && value.status !== 'adopted') fail('工作只能采用当前已采纳的项目资料');
    if (kind === 'workItems' && ['cancelled', 'superseded'].includes(value.status)) fail('工作输入已被撤销或替代');
    if (kind === 'projectMaterials') {
      if (invalidMaterial.has(value.status)) fail('项目素材已失效，不能继续作为工作输入');
      const asset = this.store.get('contentAssets', value.assetId);
      if (!asset || asset.projectId !== projectId || asset.sha256 !== value.sha256) fail('项目素材与已登记资产不一致');
      this.inspectAsset(asset);
      return { ...value, asset };
    }
    return value;
  }

  prepareAttempt({ projectId, workItemId, generation, attemptId, inputRefs = [], context }) {
    for (const value of [projectId, workItemId, attemptId]) if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) fail('工作身份无效', 400);
    if (!Number.isInteger(generation) || generation < 1) fail('工作 generation 无效', 400);
    const work = this.store.get('workItems', workItemId);
    if (work && (work.projectId !== projectId || work.generation !== generation)) fail('工作输入已被替代');
    const records = inputRefs.map(original => {
      const value = this.resolveRef(projectId, original), kind = refKinds[original.kind];
      const revision = kind === 'projects' ? value.briefVersion : value.revision;
      const digest = value.digest || value.manifestHash || value.outputDigest || value.resultDigest || value.sha256;
      return { ref: { ...original, ...(revision === undefined ? {} : { revision }),
        ...(value.generation === undefined ? {} : { generation: value.generation }), ...(digest ? { digest } : {}) }, value };
    });
    inputRefs = records.map(record => record.ref);
    const workspace = path.join(this.attemptRoot, projectId, workItemId, attemptId);
    materialTarget(this.attemptRoot, path.relative(this.attemptRoot, workspace));
    if (fs.existsSync(workspace)) fail('每个 attempt 必须使用全新的独立目录');
    fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(path.join(workspace, 'inputs')); fs.mkdirSync(path.join(workspace, 'outputs'));
    materialTarget(this.attemptRoot, path.relative(this.attemptRoot, workspace));
    const inputs = [];
    let inputBytes = 0;
    const assetsByPath = new Map(this.store.list('contentAssets').filter(asset => !asset.projectId || asset.projectId === projectId)
      .map(asset => [asset.path, asset]));
    const copiedAssets = new Map();
    const copyAsset = asset => {
      if (copiedAssets.has(asset.path)) return copiedAssets.get(asset.path);
      this.inspectAsset(asset);
      const extension = path.extname(asset.path);
      const relativePath = `inputs/materials/${copiedAssets.size + 1}-${asset.sha256.slice(0, 12)}${extension}`;
      const bytes = fs.readFileSync(asset.path);
      if ((inputBytes += bytes.length) > 100 * 1024 * 1024) fail('固定输入材料总量超过 100 MiB');
      fs.mkdirSync(path.join(workspace, 'inputs', 'materials'), { recursive: true });
      fs.writeFileSync(path.join(workspace, relativePath), bytes, { flag: 'wx' });
      inputs.push({ path: relativePath, relativePath, sha256: asset.sha256, size: bytes.length });
      copiedAssets.set(asset.path, relativePath);
      return relativePath;
    };
    const snapshot = value => {
      if (Array.isArray(value)) return value.map(snapshot);
      if (!value || typeof value !== 'object') return value;
      const asset = value.path && assetsByPath.get(value.path);
      const referencedAsset = value.assetId && this.store.get('contentAssets', value.assetId);
      if (referencedAsset && referencedAsset.projectId && referencedAsset.projectId !== projectId) fail('固定输入中的素材不属于当前项目');
      if (asset && (value.sha256 || value.hash) !== asset.sha256) fail('依赖成果摘要与资产登记不一致');
      const result = {};
      for (const [key, child] of Object.entries(value)) {
        if (['workspace', 'nativeLog', 'logFile', 'runtimeEnvironment', 'leaseToken', 'token', 'controllerToken'].includes(key)) continue;
        if (key === 'path' && asset) result.path = copyAsset(asset);
        else if (['path', 'filename', 'localPath'].includes(key) && typeof child === 'string' && path.isAbsolute(child)) continue;
        else result[key] = snapshot(child);
      }
      if (referencedAsset && !result.asset) result.asset = snapshot(referencedAsset);
      return result;
    };
    const save = (name, value) => {
      const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8'), relativePath = `inputs/${name}`;
      if (bytes.length > 4 * 1024 * 1024) fail('固定输入超过 4 MiB 上限');
      fs.writeFileSync(path.join(workspace, relativePath), bytes, { flag: 'wx' });
      inputs.push({ path: relativePath, relativePath, sha256: contentDigest(bytes), size: bytes.length });
    };
    save('context.json', snapshot(context ? { ...context, inputRefs } : buildProjectContext(this.store, projectId, { inputRefs, workItemId })));
    save('references.json', snapshot(records));
    const attempt = { id: attemptId, projectId, workItemId, generation, workspace, inputRefs,
      inputs, inputDigest: contentDigest({ projectId, workItemId, generation, inputs }), createdAt: now() };
    this.store.put('businessAttempts', attempt);
    return attempt;
  }

  inspectAttemptInputs(attempt) {
    if (!attempt || !inside(this.attemptRoot, attempt.workspace) || attempt.workspace === this.attemptRoot) fail('attempt 目录不属于成果服务');
    const root = materialTarget(this.attemptRoot, path.relative(this.attemptRoot, attempt.workspace));
    if (!fs.statSync(root).isDirectory()) fail('attempt 目录缺失');
    for (const input of attempt.inputs) {
      const filename = materialTarget(root, input.path);
      const stat = fs.statSync(filename);
      if (!stat.isFile() || stat.size !== input.size || contentDigest(fs.readFileSync(filename)) !== input.sha256) fail('固定输入被修改，拒绝收取成果');
    }
    const expected = new Set(attempt.inputs.map(input => input.path));
    let count = 0;
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = materialTarget(root, path.relative(root, path.join(directory, entry.name)));
        const stat = fs.lstatSync(filename);
        if (++count > 3000) fail('attempt 文件数量超过上限');
        if (stat.isDirectory()) walk(filename);
        else if (!stat.isFile()) fail('attempt 含非普通文件');
        const relativePath = path.relative(root, filename).split(path.sep).join('/');
        if (stat.isFile() && relativePath.startsWith('inputs/') && !expected.has(relativePath)) fail('固定输入目录被添加未登记文件');
      }
    };
    walk(root);
    // Immutable local copies establish what the worker read. Current references
    // separately establish whether that input can still qualify a new result.
    for (const ref of attempt.inputRefs) this.resolveRef(attempt.projectId, ref);
    return true;
  }

  storeAsset(bytes, { projectId, source, templateVersion = null, renderCheck = null, mime, originalName = '', image = false } = {}) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 20 * 1024 * 1024) fail('成果文件大小无效', 400);
    if (source !== undefined && canonicalJson(source).length > 12000) fail('素材来源描述超过上限', 400);
    const dimensions = image ? inspectImage(bytes) : {};
    const sha256 = contentDigest(bytes), detectedMime = dimensions.mime || mime || 'application/octet-stream';
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'application/json': 'json', 'text/plain': 'txt' })[detectedMime] || 'bin';
    const target = path.join(this.objectRoot, sha256.slice(0, 2), `${sha256}.${extension}`);
    materialTarget(this.objectRoot, path.relative(this.objectRoot, target));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      materialTarget(this.objectRoot, path.relative(this.objectRoot, target));
      if (contentDigest(fs.readFileSync(target)) !== sha256) fail('已有不可变成果遭到修改，拒绝覆盖');
    } else {
      const descriptor = fs.openSync(target, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
    // Provenance may differ for identical bytes; asset identity includes provenance rather than rewriting it.
    const assetId = `asset-${contentDigest({ sha256, projectId: projectId || null, source: source || null, templateVersion, renderCheck })}`;
    const previous = this.store.get('contentAssets', assetId);
    if (previous) return previous;
    const asset = { id: assetId, projectId: projectId || null, path: target, sha256, hash: sha256, size: bytes.length,
      mime: detectedMime, ...dimensions, source: source || null, templateVersion, renderCheck, originalName, createdAt: now() };
    // A crash before this insert leaves an orphan object, never a partially referenced revision.
    this.store.put('contentAssets', asset);
    return asset;
  }

  collectAttempt(attempt, { outputs = [], isCurrent = () => true } = {}) {
    if (!isCurrent()) fail('旧 attempt 不能提交成果');
    this.inspectAttemptInputs(attempt);
    if (outputs.length > 32) fail('声明产物过多');
    const seen = new Set(), pending = [];
    let totalBytes = 0;
    for (const declaration of outputs) {
      materialName(declaration.path);
      if (declaration.path.startsWith('inputs/') || seen.has(declaration.path.toLowerCase())) fail('输出路径与输入或其他输出重叠');
      seen.add(declaration.path.toLowerCase());
      const filename = materialTarget(attempt.workspace, declaration.path), stat = fs.statSync(filename);
      if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024 || (totalBytes += stat.size) > 80 * 1024 * 1024) fail('声明产物缺失或超过文件大小上限');
      const bytes = fs.readFileSync(filename);
      let mime = 'application/octet-stream', image = false;
      if (declaration.format === 'json' || declaration.path.endsWith('.json')) { JSON.parse(bytes.toString('utf8')); mime = 'application/json'; }
      if (declaration.format === 'text' || /\.(txt|md)$/i.test(declaration.path)) mime = 'text/plain';
      if (['png', 'jpeg', 'jpg', 'image'].includes(declaration.format) || /\.(png|jpe?g)$/i.test(declaration.path)) { inspectImage(bytes); image = true; }
      pending.push({ declaration, bytes, mime, image });
    }
    if (!isCurrent()) fail('旧 attempt 不能提交成果');
    const files = pending.map(({ declaration, bytes, mime, image }) => ({ ...this.storeAsset(bytes, { projectId: attempt.projectId, mime, image,
      source: { kind: 'member_output', workItemId: attempt.workItemId, attemptId: attempt.id, relativePath: declaration.path }, originalName: declaration.path }),
      relativePath: declaration.path }));
    this.inspectAttemptInputs(attempt);
    if (!isCurrent()) fail('收取期间工作已被替代');
    return { files, inputDigest: attempt.inputDigest, manifestHash: contentDigest(files.map(file => ({ path: file.relativePath, sha256: file.sha256 }))) };
  }

  createRevision(contentId, input, { expectedGeneration } = {}) {
    const parsed = contentInputSchema.parse(input), initial = this.requireItem(contentId);
    const generation = expectedGeneration ?? initial.generation;
    if (initial.status === 'abandoned') fail('已放弃的稿件不能继续制作');
    if (initial.status === 'published' || this.store.list('publicationAttempts').some(attempt => attempt.contentId === contentId &&
      attempt.status === 'published' && attempt.verification?.matched === true)) fail('已发布内容需要新建稿件并预留名额，原发布版本保持不变');
    const payload = normalizeNotePayload(parsed);
    const images = parsed.images.map(image => {
      let asset;
      if (image?.assetId) asset = this.store.get('contentAssets', image.assetId);
      else if (Buffer.isBuffer(image?.bytes)) asset = this.storeAsset(image.bytes, { projectId: initial.projectId, source: image.source,
        templateVersion: image.templateVersion, renderCheck: image.renderCheck, image: true });
      else if (image?.id) asset = this.store.get('contentAssets', image.id);
      if (!asset || !asset.mime?.startsWith('image/') || asset.projectId && asset.projectId !== initial.projectId) fail('整稿只能引用本项目已登记的真实图片');
      this.inspectAsset(asset);
      return asset;
    });
    return this.store.transaction(() => {
      const item = this.requireItem(contentId);
      if (item.generation !== generation || item.currentRevisionId !== initial.currentRevisionId) fail('稿件已更新，请基于当前版本重新制作');
      if (item.status === 'published' || this.store.list('publicationAttempts').some(attempt => attempt.contentId === contentId &&
        attempt.status === 'published' && attempt.verification?.matched === true)) fail('此稿件已核实发布，新内容需要另建稿件');
      for (const ref of parsed.inputRefs) this.resolveRef(item.projectId, ref);
      const revisionNumber = this.store.list('contentRevisions').filter(version => version.contentId === contentId).length + 1;
      const manifest = { schemaVersion: 1, moduleId: 'xiaohongshu', moduleVersion: '1', projectId: item.projectId, contentId,
        payload: { ...payload, images: images.map((image, order) => ({ order, sha256: image.sha256, mime: image.mime,
          width: image.width, height: image.height, size: image.size, source: image.source, templateVersion: image.templateVersion })) },
        sources: parsed.sources, inputRefs: parsed.inputRefs };
      const manifestHash = contentDigest(manifest);
      const revision = { id: id('content-version'), contentId, projectId: item.projectId, generation, revision: revisionNumber,
        parentId: item.currentRevisionId, ...payload, topics: payload.tags, images, sources: parsed.sources, inputRefs: parsed.inputRefs,
        authorMemberIds: [...new Set(parsed.authorMemberIds)], changeSummary: parsed.changeSummary,
        manifest, manifestHash, digest: manifestHash, createdAt: now() };
      revision.reviewScopeDigest = reviewScopeDigest(revision);
      const previousEligibility = this.store.get('contentEligibilities', contentId);
      const priorVersion = item.currentRevisionId && this.store.get('contentRevisions', item.currentRevisionId);
      const priorReview = previousEligibility?.reviewId && this.store.get('reviews', previousEligibility.reviewId);
      const project = this.store.get('projects', item.projectId);
      const scopeUnchanged = priorVersion && reviewScopeDigest(priorVersion) === revision.reviewScopeDigest &&
        contentDigest(priorVersion.schedule) !== contentDigest(revision.schedule);
      const reuseReview = scopeUnchanged && previousEligibility?.valid === true && previousEligibility.status === 'eligible' &&
        previousEligibility.versionId === priorVersion.id && priorReview?.versionId === priorVersion.id &&
        priorReview.manifestHash === priorVersion.manifestHash && priorReview.status === 'current' && !priorReview.invalidatedAt &&
        priorReview.verdict === 'approve' && this.verifiedReviewOrigin(priorReview, project, priorVersion) &&
        previousEligibility.checkIds.length > 0 && previousEligibility.checkIds.every(checkId => {
          const check = this.store.get('contentChecks', checkId);
          return check?.passed === true && check.status === 'passed' && !check.invalidatedAt;
        });
      if (item.currentRevisionId) this.invalidateContent(contentId, scopeUnchanged ? '发布排期已变化，需重新批准发布范围' : '稿件已产生新版本',
        { preserveEvidence: Boolean(reuseReview) });
      this.store.put('contentRevisions', revision);
      const inspected = this.inspectRevision(revision.id);
      const check = this.store.put('contentChecks', { id: id('content-check'), contentId, projectId: item.projectId, versionId: revision.id,
        manifestHash, ...inspected, status: inspected.passed ? 'passed' : 'failed', evidenceType: 'machine', checkerVersion: 'xiaohongshu-v1', createdAt: now() });
      const reusedReview = reuseReview && inspected.passed ? this.store.put('reviews', { ...priorReview, id: id('review'),
        versionId: revision.id, manifestHash, reviewScopeDigest: revision.reviewScopeDigest,
        reusedFromReviewId: priorReview.id, sourceVersionId: priorReview.sourceVersionId || priorVersion.id,
        sourceReviewedAt: priorReview.sourceReviewedAt || priorReview.createdAt, evidenceReuse: 'schedule_only',
        createdAt: now(), reuseReason: '正文、图片、来源和依赖版本一致；复用既有独立审稿，排期仍需重新批准' }) : null;
      this.store.put('contentEligibilities', { id: contentId, contentId, projectId: item.projectId, versionId: revision.id,
        revision: (this.store.get('contentEligibilities', contentId)?.revision || 0) + 1,
        status: reusedReview ? 'eligible' : 'pending', valid: Boolean(reusedReview),
        inputRefs: parsed.inputRefs, checkIds: [check.id], reviewIds: reusedReview ? [reusedReview.id] : [], checkId: check.id, reviewId: reusedReview?.id || null,
        reason: reusedReview ? '' : inspected.passed ? '等待团队独立审稿' : '整稿程序检查未通过', updatedAt: now() });
      this.store.update('contentItems', contentId, { title: revision.title, currentRevisionId: revision.id,
        currentDraftVersionId: revision.id, currentReviewVersionId: reusedReview ? revision.id : null,
        status: reusedReview ? 'awaiting_approval' : inspected.passed ? 'reviewing' : 'changes_requested' });
      this.emit('content.revised', { projectId: item.projectId, contentId, versionId: revision.id });
      return revision;
    });
  }

  inspectAsset(asset) {
    if (!asset?.path || !inside(this.objectRoot, asset.path) || asset.path === this.objectRoot) fail('成果文件路径不属于不可变库');
    const filename = materialTarget(this.objectRoot, path.relative(this.objectRoot, asset.path));
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size !== asset.size || stat.size > 20 * 1024 * 1024) fail('成果文件缺失或大小已变化');
    const bytes = fs.readFileSync(filename);
    if (contentDigest(bytes) !== asset.sha256) fail('已登记的成果文件哈希发生变化');
    if (asset.mime?.startsWith('image/')) {
      const image = inspectImage(bytes);
      if (image.width !== asset.width || image.height !== asset.height || image.mime !== asset.mime) fail('图片的实际格式或尺寸已变化');
    }
    return true;
  }

  inspectRevision(versionId) {
    const revision = this.store.get('contentRevisions', versionId);
    if (!revision) fail('固定稿件版本不存在', 404);
    const result = checkNotePayload(revision);
    if (contentDigest(revision.manifest) !== revision.manifestHash) result.findings.push({ code: 'manifest_hash', severity: 'error', message: '整稿摘要不一致' });
    for (const ref of revision.inputRefs || []) {
      try { this.resolveRef(revision.projectId, ref); }
      catch (error) { result.findings.push({ code: 'dependency_changed', severity: 'error', message: error.message }); }
    }
    for (const [index, image] of revision.images.entries()) {
      try { this.inspectAsset(image); }
      catch (error) { result.findings.push({ code: 'asset_integrity', severity: 'error', message: `第 ${index + 1} 张图片：${error.message}` }); }
    }
    return { passed: result.findings.length === 0, findings: result.findings, manifestHash: revision.manifestHash };
  }

  verifiedReviewOrigin(review, project, revision) {
    const run = review?.sourceRunId && this.store.get('runs', review.sourceRunId);
    const work = run?.workItemId && this.store.get('workItems', run.workItemId);
    return Boolean(run && run.workflowKind === 'business' && run.memberId === review.memberId && review.memberId === project.reviewerId &&
      run.projectId === revision.projectId && run.executionSucceeded === true && run.status === 'succeeded' &&
      !revision.authorMemberIds.includes(review.memberId) && work?.kind === 'review' &&
      work.generation === run.generation && work.currentAttemptId === run.attemptId);
  }

  recordReview(contentId, versionId, { memberId, verdict, summary, findings = [], sourceRunId = null } = {}) {
    if (!['approve', 'changes_requested'].includes(verdict) || typeof summary !== 'string' || !summary.trim() || summary.length > 10000 || !Array.isArray(findings) || findings.length > 100) fail('审稿意见无效', 400);
    return this.store.transaction(() => {
      const item = this.requireItem(contentId), revision = this.store.get('contentRevisions', versionId);
      const project = this.store.get('projects', item.projectId), eligibility = this.store.get('contentEligibilities', contentId);
      if (!revision || revision.contentId !== contentId || item.currentRevisionId !== versionId || eligibility?.versionId !== versionId || eligibility.status === 'invalid') fail('旧版本审查不能推进当前整稿');
      if (!project.memberIds.includes(memberId) || revision.authorMemberIds.includes(memberId)) fail('内容作者不能独自审查自己的稿件', 403);
      const verifiedOrigin = this.verifiedReviewOrigin({ sourceRunId, memberId }, project, revision);
      if (sourceRunId && !verifiedOrigin) fail('审稿运行身份或工作版本无法核验');
      const prior = this.store.list('reviews').find(review => review.contentId === contentId && review.versionId === versionId && review.sourceRunId && review.sourceRunId === sourceRunId);
      if (prior) return prior;
      const review = { id: id('review'), contentId, projectId: item.projectId, versionId, manifestHash: revision.manifestHash,
        reviewScopeDigest: reviewScopeDigest(revision),
        memberId, verdict, summary, findings, sourceRunId, status: verifiedOrigin ? 'current' : 'unverified',
        evidenceType: 'agent_review', createdAt: now() };
      this.store.put('reviews', review);
      const checks = eligibility.checkIds.map(checkId => this.store.get('contentChecks', checkId));
      const approved = verifiedOrigin && verdict === 'approve' && checks.length > 0 && checks.every(check => check?.passed && check.status === 'passed') &&
        !findings.some(finding => ['critical', 'major', 'error'].includes(finding.severity) && finding.resolved !== true);
      this.store.update('contentEligibilities', contentId, { revision: eligibility.revision + 1, status: approved ? 'eligible' : 'pending', valid: approved,
        reviewIds: [...eligibility.reviewIds, review.id], reviewId: review.id,
        reason: approved ? '' : verifiedOrigin ? '团队要求修改后重新审查' : '审稿来源尚未核验' });
      this.store.update('contentItems', contentId, { status: approved ? 'awaiting_approval' : verdict === 'changes_requested' ? 'changes_requested' : 'reviewing',
        currentReviewVersionId: approved ? versionId : null });
      this.emit('content.reviewed', { contentId, projectId: item.projectId, versionId, reviewId: review.id, eligible: approved });
      return review;
    });
  }

  getBundle(contentId, versionId) {
    const item = this.requireItem(contentId);
    const revision = this.store.get('contentRevisions', versionId || item.currentRevisionId);
    if (revision && revision.contentId !== contentId) fail('版本不属于此稿件', 404);
    return { item, revision, project: this.store.get('projects', item.projectId), eligibility: this.store.get('contentEligibilities', contentId),
      checks: this.store.list('contentChecks').filter(check => check.contentId === contentId && (!revision || check.versionId === revision.id)),
      reviews: this.store.list('reviews').filter(review => review.contentId === contentId && (!revision || review.versionId === revision.id)),
      versions: this.store.list('contentRevisions').filter(version => version.contentId === contentId) };
  }

  invalidateDependencies({ projectId, refs = [], allContent = false, reason = '依赖资料已修正' }) {
    return this.store.transaction(() => {
      const affected = [];
      const dependsOn = (references, seen = new Set()) => references.some(inputRef => {
        if (refs.some(ref => refMatches(inputRef, ref))) return true;
        const kind = refKinds[inputRef.kind], key = `${kind}:${inputRef.id}:${inputRef.generation ?? inputRef.revision ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        if (seen.size > 1000) fail('依赖图超出核验上限');
        const value = kind && this.store.get(kind, inputRef.id);
        if (!value || value.projectId && value.projectId !== projectId) return false;
        const nested = [...(value.inputRefs || [])];
        if (kind === 'workItems') {
          for (const attempt of this.store.list('businessAttempts').filter(attempt => attempt.workItemId === inputRef.id &&
            (inputRef.generation === undefined || attempt.generation === inputRef.generation))) nested.push(...attempt.inputRefs);
        }
        if (value.assetId) nested.push({ kind: 'asset', id: value.assetId });
        return dependsOn(nested, seen);
      });
      for (const item of this.store.list('contentItems').filter(content => content.projectId === projectId)) {
        const revision = item.currentRevisionId && this.store.get('contentRevisions', item.currentRevisionId);
        if (allContent || dependsOn(revision?.inputRefs || [])) {
          this.invalidateContent(item.id, reason); affected.push(item.id);
        }
      }
      return affected;
    });
  }

  invalidateContent(contentId, reason = '稿件需要重新检查', { preserveEvidence = false } = {}) {
    return this.store.transaction(() => {
      const item = this.requireItem(contentId), eligibility = this.store.get('contentEligibilities', contentId);
      if (eligibility) this.store.update('contentEligibilities', contentId, { revision: eligibility.revision + 1, status: 'invalid', valid: false, reason });
      for (const kind of preserveEvidence ? [] : ['contentChecks', 'reviews']) {
        for (const record of this.store.list(kind).filter(value => value.contentId === contentId && (!eligibility || value.versionId === eligibility.versionId))) {
          this.store.update(kind, record.id, { status: 'invalid', invalidatedAt: now(), invalidationReason: reason });
        }
      }
      for (const approval of this.store.list('publicationApprovals').filter(value => value.contentId === contentId)) {
        const attempts = this.store.list('publicationAttempts').filter(attempt => attempt.approvalId === approval.id);
        if (attempts.some(attempt => attempt.submissionMayHaveOccurred)) {
          for (const attempt of attempts) if (attempt.submissionMayHaveOccurred) this.store.update('publicationAttempts', attempt.id, { dependencyWarning: reason });
        } else if (!terminalPublication.has(approval.status)) this.store.update('publicationApprovals', approval.id, { status: 'revoked', revokedAt: now(), reason });
      }
      for (const attempt of this.store.list('publicationAttempts').filter(value => value.contentId === contentId && !value.submissionMayHaveOccurred)) {
        if (!terminalPublication.has(attempt.status)) this.store.update('publicationAttempts', attempt.id, { status: 'blocked', reason });
      }
      for (const job of this.durable.listJobs({ statuses: ['queued'] })) {
        if (job.payload.contentId === contentId && job.kind.startsWith('publication')) this.durable.cancelJobs({ contentId, kind: job.kind, reason });
      }
      const mayHaveSubmitted = this.store.list('publicationAttempts').some(attempt => attempt.contentId === contentId && attempt.submissionMayHaveOccurred);
      this.store.update('contentItems', contentId, { currentReviewVersionId: null, ...(mayHaveSubmitted ? { dependencyWarning: reason } : { status: 'changes_requested' }) });
      this.emit('content.invalidated', { projectId: item.projectId, contentId, reason });
      return this.store.get('contentEligibilities', contentId);
    });
  }

  abandon(contentId) {
    return this.store.transaction(() => {
      this.invalidateContent(contentId, '用户明确放弃此稿件');
      this.durable.releaseContentSlot(contentId, { reason: 'abandoned' });
      return this.store.update('contentItems', contentId, { status: 'abandoned', abandonedAt: now() });
    });
  }

  orphanObjects() {
    const registered = new Set(this.store.list('contentAssets').map(asset => path.resolve(asset.path)));
    const orphaned = [];
    for (const shard of fs.readdirSync(this.objectRoot, { withFileTypes: true })) {
      if (!shard.isDirectory() || shard.isSymbolicLink()) continue;
      for (const entry of fs.readdirSync(path.join(this.objectRoot, shard.name), { withFileTypes: true })) {
        const filename = path.join(this.objectRoot, shard.name, entry.name);
        if (entry.isFile() && !registered.has(filename)) orphaned.push({ path: filename, status: 'unreferenced' });
      }
    }
    return orphaned;
  }
}
