import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

/**
 * 点云文件读写：浏览器端解析 PLY / PCD / 文本坐标文件，以及导出带法向的 PLY。
 */

/** 支持的文件类型提示文本 */
export const SUPPORTED_EXT = '.ply / .pcd / .xyz / .asc / .txt';

/**
 * 解析纯文本坐标文件：每行 "x y z [r g b]" 或 "x y z nx ny nz"，分隔符支持空格、逗号、分号、制表符。
 * 第 4~6 列是颜色还是法向，由文件头注释是否含 nx ny nz 决定（本模块导出的 XYZ 会写入该注释）。
 */
export function parseTextPoints(text) {
  const coords = [];
  const colors = [];
  const normalData = [];
  let hasColor = false;
  let hasNormalHeader = false; // 头部声明了法向列

  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;

    if (s.startsWith('#') || s.startsWith('//')) {
      // 导出时头部写入 "# x y z nx ny nz"，据此把 6 列读作法向而非颜色
      if (/\bnx\b/.test(s) && /\bny\b/.test(s) && /\bnz\b/.test(s)) hasNormalHeader = true;
      continue;
    }

    const parts = s.split(/[\s,;]+/).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) continue;

    coords.push(parts[0], parts[1], parts[2]);

    if (hasNormalHeader) {
      // 法向列：缺列时补 0，最终长度不一致会被调用方忽略
      normalData.push(parts[3] ?? 0, parts[4] ?? 0, parts[5] ?? 0);
      colors.push(1, 1, 1);
    } else if (parts.length >= 6) {
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
    normals: hasNormalHeader && normalData.length === coords.length ? new Float32Array(normalData) : null,
  };
}

/**
 * 统一解析入口，返回 { positions, colors, normals } 便于交给 viewer 渲染。
 * normals 仅在源文件自带法向时存在（如已做法的 PLY），可为空。
 */
export async function parsePointFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'ply') {
    const geometry = new PLYLoader().parse(await file.arrayBuffer());
    const positions = geometry.attributes.position.array;
    const colors = geometry.attributes.color ? geometry.attributes.color.array : null;
    const normals = geometry.attributes.normal ? geometry.attributes.normal.array : null;
    geometry.dispose();
    return { positions, colors, normals };
  }

  if (ext === 'pcd') {
    const points = new PCDLoader().parse(await file.arrayBuffer());
    const positions = points.geometry.attributes.position.array;
    const colors = points.geometry.attributes.color ? points.geometry.attributes.color.array : null;
    const normals = points.geometry.attributes.normal ? points.geometry.attributes.normal.array : null;
    points.geometry.dispose();
    return { positions, colors, normals };
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

/**
 * 解析网格文件（PLY / OBJ），返回 { positions, indices, normals }。
 * 无面片数据的文件会抛错，便于调用方提示"该文件不含三角面"。
 * @param {File} file
 */
export async function parseMeshFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'obj') return parseObjMesh(await file.text());
  if (ext !== 'ply') throw new Error('网格导入目前仅支持 .ply / .obj');

  const geometry = new PLYLoader().parse(await file.arrayBuffer());
  const positions = geometry.attributes.position.array;
  const normals = geometry.attributes.normal ? geometry.attributes.normal.array : null;
  const indexAttr = geometry.index;

  if (!indexAttr || indexAttr.count < 3) {
    geometry.dispose();
    throw new Error('文件中没有三角面片数据');
  }

  const indices = Uint32Array.from(indexAttr.array);
  geometry.dispose();
  return { positions, indices, normals };
}

/**
 * 生成三角网格 ASCII PLY 文本，供曲面重建 / 后处理结果导出。
 * @param {Float32Array} positions 顶点坐标
 * @param {Uint32Array|number[]} indices 三角面顶点索引
 * @param {string} comment 头部注释
 * @returns {string}
 */
export function buildPlyMesh(positions, indices, comment = 'triangle mesh') {
  const V = positions.length / 3;
  const F = indices.length / 3;
  const lines = [
    'ply',
    'format ascii 1.0',
    `comment ${comment}`,
    `element vertex ${V}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${F}`,
    'property list uchar int vertex_indices',
    'end_header',
  ];

  for (let i = 0; i < V; i++) {
    lines.push(
      `${positions[i * 3].toFixed(6)} ${positions[i * 3 + 1].toFixed(6)} ${positions[i * 3 + 2].toFixed(6)}`,
    );
  }
  for (let f = 0; f < F; f++) {
    lines.push(`3 ${indices[f * 3]} ${indices[f * 3 + 1]} ${indices[f * 3 + 2]}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 生成带法向的 XYZ 文本：首行注释声明列含义，后续每行 "x y z nx ny nz"。
 * 注释头是本模块重新导入时识别法向的依据，勿删。
 * @param {Float32Array} positions 顶点坐标
 * @param {Float32Array} normals 法向
 * @param {string} comment 额外说明
 */
export function buildXyzWithNormals(positions, normals, comment = 'point cloud with normals') {
  const n = positions.length / 3;
  const lines = [`# ${comment}`, '# x y z nx ny nz'];
  for (let i = 0; i < n; i++) {
    lines.push(
      `${positions[i * 3].toFixed(6)} ${positions[i * 3 + 1].toFixed(6)} ${positions[i * 3 + 2].toFixed(6)} ` +
        `${normals[i * 3].toFixed(6)} ${normals[i * 3 + 1].toFixed(6)} ${normals[i * 3 + 2].toFixed(6)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 解析 OBJ 网格：只取 v（顶点）与 f（面），面若为多边形按扇形拆成三角形。
 * @param {string} text
 */
export function parseObjMesh(text) {
  const coords = [];
  const indices = [];
  let vertexCount = 0;

  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('v ')) {
      const p = s.split(/\s+/);
      coords.push(Number(p[1]), Number(p[2]), Number(p[3]));
      vertexCount++;
      continue;
    }
    if (!s.startsWith('f ')) continue;

    const verts = s
      .split(/\s+/)
      .slice(1)
      .map((token) => {
        const idx = parseInt(token.split('/')[0], 10);
        // OBJ 索引从 1 开始，负数表示相对当前顶点的倒序引用
        return idx > 0 ? idx - 1 : vertexCount + idx;
      });
    // 多边形面按扇形三角化
    for (let i = 1; i + 1 < verts.length; i++) indices.push(verts[0], verts[i], verts[i + 1]);
  }

  if (!coords.length) throw new Error('OBJ 文件中没有顶点数据');
  if (!indices.length) throw new Error('OBJ 文件中没有面片数据');

  // 逐面剔除越界索引，避免后续渲染 / 处理崩溃
  const safe = [];
  const vCount = coords.length / 3;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    if (a >= 0 && a < vCount && b >= 0 && b < vCount && c >= 0 && c < vCount) safe.push(a, b, c);
  }
  if (!safe.length) throw new Error('OBJ 文件中没有有效三角面');

  return { positions: new Float32Array(coords), indices: new Uint32Array(safe), normals: null };
}

/**
 * 生成三角网格 OBJ 文本：顶点 "v x y z"，面 "f a b c"（索引从 1 开始）。
 * @param {Float32Array} positions 顶点坐标
 * @param {Uint32Array|number[]} indices 三角面顶点索引
 * @param {string} comment 头部注释
 * @returns {string}
 */
export function buildObjMesh(positions, indices, comment = 'triangle mesh') {
  const V = positions.length / 3;
  const F = indices.length / 3;
  const lines = [`# ${comment}`];
  for (let i = 0; i < V; i++) {
    lines.push(
      `v ${positions[i * 3].toFixed(6)} ${positions[i * 3 + 1].toFixed(6)} ${positions[i * 3 + 2].toFixed(6)}`,
    );
  }
  for (let f = 0; f < F; f++) {
    lines.push(`f ${indices[f * 3] + 1} ${indices[f * 3 + 1] + 1} ${indices[f * 3 + 2] + 1}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 触发浏览器下载纯文本文件 */
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  // 部分浏览器要求链接在文档中才会触发下载，稳妥起见先挂载再移除
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立即 revoke 会让部分浏览器来不及取数据，延迟释放
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 各扩展名对应的 MIME，用于保存对话框的类型过滤；PLY 为 ASCII 文本，统一按文本处理 */
const MIME_BY_EXT = {
  '.ply': 'text/plain',
  '.obj': 'text/plain',
  '.xyz': 'text/plain',
  '.txt': 'text/plain',
};

/**
 * 保存文本文件：文件名、保存位置与类型全部在系统保存对话框内选择，页面不再单独出控件。
 * 对话框的"保存类型"对应 formats，用户最终用哪个扩展名就写哪份内容。
 * 写入用户选定位置失败（目录权限、受控文件夹、文件被占用等）时，会回退为浏览器下载并带上原因。
 * 不支持文件系统 API（如 Firefox / 非安全上下文）时同样回退为浏览器默认下载。
 * @param {{suggestedName: string, defaultExt?: string, formats: {ext: string, description: string, text: () => string}[], onStage?: (stage: 'picker'|'building'|'writing') => void}} options
 * @returns {Promise<{saved: boolean, name: string, ext: string, via: 'picker'|'download', reason?: string}>} saved=false 表示用户取消
 */
export async function saveTextFile({ suggestedName, formats, defaultExt, onStage }) {
  if (!formats?.length) throw new Error('未提供导出格式');

  const mimeOf = (ext) => MIME_BY_EXT[ext] ?? 'text/plain';
  const def = formats.find((f) => f.ext === defaultExt) ?? formats[0];
  // 建议名去掉用户可能带入的扩展名，统一补齐默认扩展名
  const base = (suggestedName || 'export').replace(/\.[^./\\]+$/, '') || 'export';
  const fileName = `${base}${def.ext}`;

  // 跨源 iframe（如编辑器内置预览）中文件选择 API 必被拒绝，直接走下载，避免无谓报错
  const inIframe = typeof window !== 'undefined' && window.self !== window.top;
  if (!inIframe && typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    let handle = null;
    onStage?.('picker');
    try {
      // 不传 types：一旦声明了类型/扩展名白名单，用户在文件名框里写成名单外的后缀（如 .txt、.asc）
      // 浏览器会判定"扩展名与文件类型不符"并拒绝保存，对话框不关闭，页面也拿不到任何结果，
      // 表现为"点了保存却没有文件、也没有提示"。放开限制后任何文件名都能保存，
      // 内容再按最终扩展名决定，未知后缀回落到默认格式。
      handle = await window.showSaveFilePicker({ suggestedName: fileName });
    } catch (err) {
      // 用户取消：直接结束，不回退下载
      if (err?.name === 'AbortError') return { saved: false, name: fileName, ext: def.ext, via: 'picker' };
      // 对话框本身打不开（策略限制等）：回退下载
      console.warn('[export] 保存对话框不可用，回退为浏览器下载：', err);
    }

    if (handle) {
      // 按用户最终使用的扩展名生成内容，避免扩展名与格式不符
      const chosen = formats.find((f) => f.ext.toLowerCase() === extOf(handle.name)) ?? def;
      let writable = null;
      let body = '';
      try {
        onStage?.('building');
        body = chosen.text();
        onStage?.('writing');
        writable = await handle.createWritable();
        await writable.write(new Blob([body], { type: mimeOf(chosen.ext) }));
        // close 有可能长时间不返回（目标盘为网络盘/同步盘），超时后按失败处理，避免页面一直无提示
        await withTimeout(writable.close(), 60000, '写入超时（60 秒）');
        // 校验实际落盘大小：浏览器偶尔会返回成功但目录里没有内容
        const written = await handle.getFile().catch(() => null);
        if (written && body.length > 0 && written.size === 0) {
          const empty = new Error('写入的文件为空');
          empty.name = 'EmptyFileError';
          throw empty;
        }
        return { saved: true, name: handle.name, ext: chosen.ext, via: 'picker' };
      } catch (err) {
        // 写到用户选定位置失败（目录权限、受控文件夹访问、文件被其它程序占用等），
        // 别留下半截或 0 字节文件，改为下载到默认目录，并把失败原因带回页面显示
        try {
          await writable?.abort?.();
        } catch {
          /* abort 自身失败时忽略，不影响后续兜底 */
        }
        console.warn('[export] 写入自定义位置失败，回退为浏览器下载：', err);
        // 用户已付出手势点过保存，这里复用已生成的内容，避免大点云再算一遍
        downloadText(fileName, body || chosen.text(), mimeOf(chosen.ext));
        return {
          saved: true,
          name: fileName,
          ext: chosen.ext,
          via: 'download',
          reason: `保存到 ${handle.name} 失败（${err?.name || 'Error'}）`,
        };
      }
    }
  }

  downloadText(fileName, def.text(), mimeOf(def.ext));
  return { saved: true, name: fileName, ext: def.ext, via: 'download' };
}

/** 取文件名的小写扩展名，无扩展名返回空串 */
function extOf(fileName) {
  const matched = /\.[^./\\]+$/.exec(fileName || '');
  return matched ? matched[0].toLowerCase() : '';
}

/** 给可能长时间挂起的写入操作加超时，超时按失败处理并走兜底下载 */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
