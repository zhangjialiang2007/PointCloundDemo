import normals from './normals.js';
import post from './post.js';
import reconstruct from './reconstruct.js';

/**
 * 功能页注册表。总览页据此渲染三个入口卡片，路由据此找到对应页面的 mount。
 * 每个条目：id / step / title / subtitle / description / tags / accent / mount
 */
export const features = [
  {
    ...normals,
    step: '01',
    subtitle: '点云法向提取与定向',
    tags: ['PCA', 'RANSAC', 'ROBPCA/MCD', 'Hough', '自适应邻域', '漂移邻域'],
    accent: '#4ea1ff',
  },
  {
    ...reconstruct,
    step: '02',
    subtitle: '点云转三角网格',
    tags: ['泊松重建', 'BPA 球旋转', '空球判据三角化', 'PLY / OBJ 导出'],
    accent: '#22d3c5',
  },
  {
    ...post,
    step: '03',
    subtitle: '网格串行处理与导出',
    tags: ['面片清洗', '拓扑修复', '拉普拉斯平滑', 'QEM 简化'],
    accent: '#ffb020',
  },
];

/** 路由默认页 */
export const HOME_ID = 'home';
