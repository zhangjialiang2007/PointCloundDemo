import meshClean from './mesh-clean.js';
import meshSimplify from './mesh-simplify.js';
import meshSmooth from './mesh-smooth.js';
import meshTopology from './mesh-topology.js';
import normals from './normals.js';
import poisson from './poisson.js';

/**
 * 示例注册表：新增示例时在此处导入并加入数组即可。
 * 每个示例需提供 { id, title, description, mount({ viewer, panel }) }
 */
export const demos = [
  normals,
  poisson,
  meshClean,
  meshSmooth,
  meshSimplify,
  meshTopology,
];
