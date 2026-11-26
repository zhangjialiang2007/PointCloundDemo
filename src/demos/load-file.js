import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { addHint, addSlider } from '../core/ui.js';

/**
 * 示例：加载本地点云文件（PLY / PCD / XYZ / ASC）。
 * 支持点击选择或直接拖拽文件到视口。
 */

const EXT_LABEL = '.ply / .pcd / .xyz / .asc / .txt';

/** 解析纯文本坐标文件：每行 "x y z [r g b]"，分隔符支持空格、逗号、分号、制表符 */
function parseTextPoints(text) {
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
async function parseFile(file) {
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

export default {
  id: 'load-file',
  title: '加载点云文件',
  description: `拖拽或选择本地文件（${EXT_LABEL}）进行渲染`,

  mount({ viewer, panel }) {
    const container = viewer.container;

    // 文件选择输入
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ply,.pcd,.xyz,.asc,.txt';
    input.style.display = 'none';
    panel.appendChild(input);

    const button = document.createElement('button');
    button.textContent = '选择文件…';
    button.style.cssText =
      'width:100%;padding:7px 10px;margin-bottom:8px;border:1px solid #2c4a72;border-radius:6px;background:#1d2a3d;color:#4ea1ff;font:inherit;cursor:pointer;';
    panel.appendChild(button);

    let pointSize = 0.014;

    const load = async (file) => {
      try {
        const { positions, colors } = await parseFile(file);
        viewer.setPoints(positions, colors, { size: pointSize });
        viewer.fitToPoints(1.5);
        info.textContent = `${file.name} · ${(positions.length / 3).toLocaleString()} 点`;
      } catch (err) {
        info.textContent = `加载失败：${err.message}`;
      }
    };

    button.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files?.[0]) load(input.files[0]);
      input.value = '';
    });

    // 拖拽加载
    const onDragOver = (e) => {
      e.preventDefault();
      container.style.outline = '2px dashed #4ea1ff';
    };
    const onDragLeave = () => {
      container.style.outline = '';
    };
    const onDrop = (e) => {
      e.preventDefault();
      container.style.outline = '';
      const file = e.dataTransfer?.files?.[0];
      if (file) load(file);
    };
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragleave', onDragLeave);
    container.addEventListener('drop', onDrop);

    addSlider(panel, {
      label: '点大小',
      min: 0.002,
      max: 0.05,
      step: 0.001,
      value: pointSize,
      format: (v) => v.toFixed(3),
      onInput: (v) => {
        pointSize = v;
        viewer.setPointSize(v);
      },
    });

    const info = addHint(panel, `可将 ${EXT_LABEL} 文件拖入视口`);
    addHint(panel, '文件仅在本机浏览器中解析，不会上传');

    return {
      dispose() {
        container.removeEventListener('dragover', onDragOver);
        container.removeEventListener('dragleave', onDragLeave);
        container.removeEventListener('drop', onDrop);
        container.style.outline = '';
        viewer.disposePoints();
      },
    };
  },
};
