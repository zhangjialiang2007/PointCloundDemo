import { generateSphere } from '../core/generators.js';
import { addHint, addSlider } from '../core/ui.js';

/** 示例：程序化球面点云，用于验证渲染管线与点大小调节 */
export default {
  id: 'sphere',
  title: '球面点云',
  description: '程序生成的球面点云，可调节点数量与点大小',

  mount({ viewer, panel }) {
    let count = 50000;

    const rebuild = () => {
      viewer.setPoints(generateSphere(count, 1), null, { size: 0.012 });
      viewer.setHelpersVisible(false);
      viewer.fitToPoints();
    };

    const countCtrl = addSlider(panel, {
      label: '点数',
      min: 5000,
      max: 300000,
      step: 5000,
      value: count,
      format: (v) => `${(v / 1000).toFixed(0)}k`,
      onInput: (v) => {
        count = v;
        rebuild();
      },
    });
    void countCtrl;

    addSlider(panel, {
      label: '点大小',
      min: 0.002,
      max: 0.05,
      step: 0.001,
      value: 0.012,
      format: (v) => v.toFixed(3),
      onInput: (v) => viewer.setPointSize(v),
    });

    addHint(panel, '左键旋转 · 右键平移 · 滚轮缩放');
    rebuild();

    return {
      dispose() {
        viewer.setHelpersVisible(true);
        viewer.disposePoints();
      },
    };
  },
};
