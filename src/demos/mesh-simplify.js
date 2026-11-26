import { generateBlobMesh } from '../core/mesh.js';
import { simplifyMesh } from '../core/mesh-simplify.js';
import { addCheckbox, addHint, addSlider } from '../core/ui.js';

/**
 * 示例：网格简化（QEM 边折叠）。
 * 按二次误差度量选边折叠，在保持形状的前提下减少三角面数量。
 */

export default {
  id: 'mesh-simplify',
  title: '网格简化',
  description: 'QEM 边折叠减面，用于渲染与仿真加速',

  mount({ viewer, panel }) {
    let level = 4;
    let ratio = 0.3;
    let wireframe = true;
    let timer = null;

    let base = null;
    let result = null;
    let cost = 0;

    const render = () => {
      viewer.setMesh(result, { color: 0x8fd4c0, wireframe });
      viewer.setMeshWireframe(wireframe);
      viewer.fitToMesh(1.5);
      hint.textContent =
        `面 ${result.facesIn} → ${result.facesOut}（${(result.facesOut / result.facesIn * 100).toFixed(0)}%），` +
        `顶点 ${result.positions.length / 3}，耗时 ${cost.toFixed(0)} ms`;
    };

    const build = () => {
      base = generateBlobMesh(level, 1);
      const t0 = performance.now();
      result = simplifyMesh(base, { targetRatio: ratio });
      cost = performance.now() - t0;
      render();
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(build, 120);
    };

    addSlider(panel, {
      label: '细分级别',
      min: 3,
      max: 5,
      step: 1,
      value: level,
      format: (v) => `${v} 级`,
      onInput: (v) => {
        level = v;
        schedule();
      },
    });

    addSlider(panel, {
      label: '保留比例',
      min: 0.02,
      max: 1,
      step: 0.02,
      value: ratio,
      format: (v) => `${(v * 100).toFixed(0)}%`,
      onInput: (v) => {
        ratio = v;
        schedule();
      },
    });

    addCheckbox(panel, {
      label: '显示线框',
      checked: wireframe,
      onChange: (v) => {
        wireframe = v;
        viewer.setMeshWireframe(v);
      },
    });

    const hint = addHint(panel, '');

    build();

    return {
      dispose() {
        clearTimeout(timer);
        viewer.disposeMesh();
      },
    };
  },
};
