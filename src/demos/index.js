import loadFile from './load-file.js';
import meshClean from './mesh-clean.js';
import meshSimplify from './mesh-simplify.js';
import meshSmooth from './mesh-smooth.js';
import meshTopology from './mesh-topology.js';
import normals from './normals.js';
import poisson from './poisson.js';
import sphere from './sphere.js';
import terrain from './terrain.js';

/**
 * 示例注册表：新增示例时在此处导入并加入数组即可。
 * 每个示例需提供 { id, title, description, mount({ viewer, panel }) }
 */
export const demos = [
  sphere,
  terrain,
  normals,
  poisson,
  meshClean,
  meshSmooth,
  meshSimplify,
  meshTopology,
  loadFile,
];
