import { xiaohongshuModule } from './xiaohongshu.mjs';
export const businessModules = Object.freeze([xiaohongshuModule]);
export function getBusinessModule(moduleId) {
  const module = businessModules.find(item => item.id === moduleId);
  if (!module) throw Object.assign(new Error('业务模块未安装'), { status: 400 });
  return module;
}
