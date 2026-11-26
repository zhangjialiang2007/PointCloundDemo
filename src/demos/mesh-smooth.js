import { computeVertexNormals, generateBlobMesh } from '../core/mesh.js';
import { laplacianSmooth } from '../core/mesh-smooth.js';
import { addCheckbox, addHint, addSlider } from '../core/ui.js';

/**
 * 示例：网格平滑。
 * 拉普拉斯平滑去噪，特征点（折痕）与边界点被约束，避免棱角被磨圆。
 */

/** 稳定的伪随机数，保证滑块来回拖动时噪声形态一致 */
function hash01(i) {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/** 沿法向叠加噪声 */
function applyNoise(mesh, amplitude) {
  const normals = computeVertexNormals(mesh.positions, mesh.indices);
  const out = Float32Array.from(mesh.positions);
  const V = out.length / 3;
  for (let i = 0; i < V; i++) {
    const d = (hash01(i) - 0.5) * 2 * amplitude;
    out[i * 3] += normals[i * 3] * d;
    out[i * 3 + 1] += normals[i * 3 + 1] * d;
    out[i * 3 + 2] += normals[i * 3 + 2] * d;
  }
  return out;
}

export default {
  id: 'mesh-smooth',
  title: '网格平滑',
  description: '拉普拉斯平滑去噪，约束特征点保留棱角',

  mount({ viewer, panel }) {
    const base = generateBlobMesh(4, 1);

    let amplitude = 0.03;
    let iterations = 6;
    let featureAngle = 45;
    let preserveFeatures = true;
    let taubin = false;
    let showSmoothed = true;

    let noisyMesh = null;
    let smoothedPositions = null;
    let featureCount = 0;
    let cost = 0;

    const render = () => {
      const data = showSmoothed
        ? { positions: smoothedPositions, indices: base.indices }
        : noisyMesh;
      viewer.setMesh(data, {
        color: showSmoothed ? 0xa8d8ff : 0xf0b27a,
        wireframe: true,
        flatShading: false, // 平滑着色，便于观察平滑效果
      });
      viewer.fitToMesh(1.5);

      hint.textContent = showSmoothed
        ? `平滑结果：特征点 ${featureCount} 个，迭代 ${iterations} 次，耗时 ${cost.toFixed(0)} ms`
        : `带噪声输入：幅度 ${amplitude.toFixed(3)}`;
    };

    const build = () => {
      noisyMesh = { positions: applyNoise(base, amplitude), indices: base.indices };
      const t0 = performance.now();
      const result = laplacianSmooth(noisyMesh, {
        iterations,
        lambda: 0.5,
        featureAngle,
        preserveFeatures,
        tangential: true,
        taubin,
      });
      cost = performance.now() - t0;
      smoothedPositions = result.positions;
      featureCount = result.featureCount;
      render();
    };

    addSlider(panel, {
      label: '噪声幅度',
      min: 0,
      max: 0.07,
      step: 0.002,
      value: amplitude,
      format: (v) => v.toFixed(3),
      onInput: (v) => {
        amplitude = v;
        build();
      },
    });

    addSlider(panel, {
      label: '迭代次数',
      min: 1,
      max: 20,
      step: 1,
      value: iterations,
      format: (v) => String(v),
      onInput: (v) => {
        iterations = v;
        build();
      },
    });

    addSlider(panel, {
      label: '特征角阈值',
      min: 10,
      max: 80,
      step: 5,
      value: featureAngle,
      format: (v) => `${v}°`,
      onInput: (v) => {
        featureAngle = v;
        build();
      },
    });

    addCheckbox(panel, {
      label: '约束特征点',
      checked: preserveFeatures,
      onChange: (v) => {
        preserveFeatures = v;
        build();
      },
    });

    addCheckbox(panel, {
      label: 'Taubin 收缩补偿',
      checked: taubin,
      onChange: (v) => {
        taubin = v;
        build();
      },
    });

    addCheckbox(panel, {
      label: '显示平滑结果',
      checked: showSmoothed,
      onChange: (v) => {
        showSmoothed = v;
        render();
      },
    });

    const hint = addHint(panel, '');

    build();

    return {
      dispose() {
        viewer.disposeMesh();
      },
    };
  },
};
