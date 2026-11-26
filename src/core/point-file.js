import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

/**
 * 点云文件读写：浏览器端解析 PLY / PCD / 文本坐标文件，以及导出带法向的 PLY。
 */

/** 支持的文件类型提示文本 */
export const SUPPORTED_EXT = '.ply / .pcd / .xyz / .asc / .txt';

/** 解析纯文本坐标文件：每行 "x y z [r g b]"，分隔符支持空格、逗号、分号、制表符 */
export function parseTextPoints(text) {
  const coords = [];
  const colors = [];
  let hasColor = false;

  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith('//')) continue;

    const parts = s.split(/[\s,;]+/).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) continue;

    coords.push(parts[0], parts[1], parts[2]);

    if (parts.length >= 6) {
      // 颜色可能为 0~255 或 0~1，按最大值判断
      const rgb = parts.slice(3, 6);
      const scale = Math.max(...rgb) > 1 ? 255 : 1;
      colors.push(rgb[0] / scale, rgb[1] / scale, rgb[2] / scale);
      hasColor = true;
    } else {
      colors.push(1, 1, 1);
    }
  }

  if (!coords.length) throw new Error('文件中没有解析到有效坐标');
  return {
    positions: new Float32Array(coords),
    colors: hasColor ? new Float32Array(colors) : null,
  };
}

/** 统一解析入口，返回 { positions, colors } 便于交给 viewer 渲染 */
export async function parsePointFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'ply') {
    const geometry = new PLYLoader().parse(await file.arrayBuffer());
    const positions = geometry.attributes.position.array;
    const colors = geometry.attributes.color ? geometry.attributes.color.array : null;
    geometry.dispose();
    return { positions, colors };
  }

  if (ext === 'pcd') {
    const points = new PCDLoader().parse(await file.arrayBuffer());
    const positions = points.geometry.attributes.position.array;
    const colors = points.geometry.attributes.color ? points.geometry.attributes.color.array : null;
    points.geometry.dispose();
    return { positions, colors };
  }

  return parseTextPoints(await file.text());
}

/**
 * 生成带法向的 ASCII PLY 文本，可直接导入 MeshLab / Open3D 做泊松重建。
 * @param {Float32Array} positions 顶点坐标
 * @param {Float32Array} normals 法向
 * @param {string} comment 头部注释
 * @returns {string}
 */
export function buildPlyWithNormals(positions, normals, comment = 'point cloud with normals') {
  const n = positions.length / 3;
  const lines = [
    'ply',
    'format ascii 1.0',
    `comment ${comment}`,
    `element vertex ${n}`,
    'property float x',
    'property float y',
    'property float z',
    'property float nx',
    'property float ny',
    'property float nz',
    'end_header',
  ];

  for (let i = 0; i < n; i++) {
    lines.push(
      `${positions[i * 3].toFixed(6)} ${positions[i * 3 + 1].toFixed(6)} ${positions[i * 3 + 2].toFixed(6)} ` +
        `${normals[i * 3].toFixed(6)} ${normals[i * 3 + 1].toFixed(6)} ${normals[i * 3 + 2].toFixed(6)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** 触发浏览器下载纯文本文件 */
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
