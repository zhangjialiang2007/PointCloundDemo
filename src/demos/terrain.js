import { colorByHeight, generateTerrain } from '../core/generators.js';
import { addHint, addSlider } from '../core/ui.js';

/** 示例：起伏地形点云，按高度着色，便于观察高程分布 */
export default {
  id: 'terrain',
  title: '地形高度着色',
  description: '多层正弦生成地形点云，按高程映射蓝→红颜色',

  mount({ viewer, panel }) {
    let count = 80000;

    const rebuild = () => {
      const positions = generateTerrain(count, 4);
      viewer.setPoints(positions, colorByHeight(positions), { size: 0.014 });
      viewer.fitToPoints(1.4);
    };

    addSlider(panel, {
      label: '点数',
      min: 10000,
      max: 300000,
      step: 10000,
      value: count,
      format: (v) => `${(v / 1000).toFixed(0)}k`,
      onInput: (v) => {
        count = v;
        rebuild();
      },
    });

    addSlider(panel, {
      label: '点大小',
      min: 0.004,
      max: 0.05,
      step: 0.001,
      value: 0.014,
      format: (v) => v.toFixed(3),
      onInput: (v) => viewer.setPointSize(v),
    });

    addHint(panel, '颜色由低到高：蓝 → 青 → 绿 → 黄 → 红');
    rebuild();

    return {
      dispose() {
        viewer.disposePoints();
      },
    };
  },
};
