import { generateBlobMesh } from '../core/mesh.js';
import { injectDefects } from '../core/mesh-defects.js';
import { cleanMesh, findDegenerateFaces, findSelfIntersectingFaces } from '../core/mesh-clean.js';
import { addCheckbox, addHint, addSlider } from '../core/ui.js';

/**
 * 示例：面片清洗。
 * 在干净网格上注入退化三角、自交面片与翻转法向，检测并剔除后再统一朝向。
 */

const COLORS = {
  normal: [0.5, 0.7, 0.92],
  degenerate: [1, 0.66, 0.16],
  selfIntersect: [1, 0.28, 0.22],
};

export default {
  id: 'mesh-clean',
  title: '面片清洗',
  description: '删除退化三角与自交面片，统一法向朝向',

  mount({ viewer, panel }) {
    let level = 4;
    let defectCount = 14;
    let showCleaned = false;
    let markDefects = true;

    let dirtyMesh = null;
    let cleanedMesh = null;
    let faceColors = null;
    let stats = null;
    let timer = null;

    const render = () => {
      const useClean = showCleaned;
      viewer.setMesh(useClean ? cleanedMesh : dirtyMesh, {
        color: useClean ? 0x7fd4a8 : 0x86bce8,
        faceColors: !useClean && markDefects ? faceColors : null,
        wireframe: true,
      });
      viewer.fitToMesh(1.5);

      hint.textContent = useClean
        ? `清洗后：面 ${stats.facesOut}（原 ${stats.facesIn}），剔除 ${stats.removed}，翻转 ${stats.flipped}`
        : `原始：面 ${stats.facesIn}，退化 ${stats.degenerate}，自交 ${stats.selfIntersect}`;
    };

    const build = () => {
      const base = generateBlobMesh(level, 1);
      dirtyMesh = injectDefects(base, {
        degenerate: defectCount,
        crossing: Math.round(defectCount * 0.6),
        fins: 0,
        flippedRatio: 0.05,
      });

      const degenerate = findDegenerateFaces(dirtyMesh.positions, dirtyMesh.indices);
      const selfIntersect = findSelfIntersectingFaces(dirtyMesh.positions, dirtyMesh.indices);
      const result = cleanMesh(dirtyMesh);
      cleanedMesh = result.mesh;
      stats = result.stats;

      // 逐面着色：自交红、退化橙、其余蓝灰
      const F = dirtyMesh.indices.length / 3;
      faceColors = new Float32Array(F * 3);
      for (let f = 0; f < F; f++) {
        const c = selfIntersect.has(f)
          ? COLORS.selfIntersect
          : degenerate.has(f)
            ? COLORS.degenerate
            : COLORS.normal;
        faceColors[f * 3] = c[0];
        faceColors[f * 3 + 1] = c[1];
        faceColors[f * 3 + 2] = c[2];
      }
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
      label: '缺陷数量',
      min: 0,
      max: 30,
      step: 1,
      value: defectCount,
      format: (v) => String(v),
      onInput: (v) => {
        defectCount = v;
        schedule();
      },
    });

    addCheckbox(panel, {
      label: '显示清洗结果',
      checked: showCleaned,
      onChange: (v) => {
        showCleaned = v;
        render();
      },
    });

    addCheckbox(panel, {
      label: '标记缺陷面片',
      checked: markDefects,
      onChange: (v) => {
        markDefects = v;
        render();
      },
    });

    const hint = addHint(panel, '');
    addHint(panel, '橙色：退化三角 / 红色：自交面片');

    build();

    return {
      dispose() {
        clearTimeout(timer);
        viewer.disposeMesh();
      },
    };
  },
};
