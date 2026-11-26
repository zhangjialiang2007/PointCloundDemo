import * as THREE from 'three';
import { buildEdgeFaces, generateBlobMesh } from '../core/mesh.js';
import { injectDefects } from '../core/mesh-defects.js';
import { analyzeTopology, repairTopology } from '../core/mesh-topology.js';
import { addCheckbox, addHint } from '../core/ui.js';

/**
 * 示例：修复拓扑。
 * 重建结果常带非流形边（一条边 3 个以上面片）与蝴蝶结顶点，无法直接用于仿真；
 * 这里拆分边与顶点，使每条边最多关联 2 个面片。
 */

export default {
  id: 'mesh-topology',
  title: '修复拓扑',
  description: '拆分非流形边与顶点，保证网格是流形',

  mount({ viewer, panel }) {
    let showRepaired = false;
    let highlight = true;

    let dirtyMesh = null;
    let repairedMesh = null;
    let before = null;
    let after = null;
    let highlightLines = null;

    /** 把非流形边画成红线，便于定位问题 */
    const buildHighlight = () => {
      viewer.removeObject(highlightLines);
      highlightLines = null;

      const edges = buildEdgeFaces(dirtyMesh.indices);
      const points = [];
      for (const rec of edges.values()) {
        if (rec.faces.length <= 2) continue;
        for (const v of [rec.a, rec.b]) {
          points.push(
            dirtyMesh.positions[v * 3],
            dirtyMesh.positions[v * 3 + 1],
            dirtyMesh.positions[v * 3 + 2],
          );
        }
      }
      if (!points.length) return;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
      geometry.computeBoundingSphere();
      highlightLines = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xff4d3d, linewidth: 2 }),
      );
      viewer.addObject(highlightLines);
    };

    const render = () => {
      viewer.setMesh(showRepaired ? repairedMesh : dirtyMesh, {
        color: showRepaired ? 0x7fd4a8 : 0xe0a86a,
        wireframe: true,
      });
      if (highlightLines) highlightLines.visible = !showRepaired && highlight;
      viewer.fitToMesh(1.5);

      const a = showRepaired ? after : before;
      hint.textContent =
        `${showRepaired ? '修复后' : '修复前'}：面 ${a.faces}，顶点 ${a.vertices}，` +
        `非流形边 ${a.nonManifoldEdges}，非流形点 ${a.nonManifoldVertices}，边界边 ${a.boundaryEdges}，` +
        `连通分量 ${a.components}，欧拉示性数 ${a.euler}，流形 ${a.isManifold ? '是' : '否'}`;
    };

    // 构造带缺陷的网格并修复
    const base = generateBlobMesh(4, 1);
    dirtyMesh = injectDefects(base, { degenerate: 8, crossing: 0, fins: 8, flippedRatio: 0.05 });
    before = analyzeTopology(dirtyMesh);
    const repaired = repairTopology(dirtyMesh);
    repairedMesh = repaired.mesh;
    after = analyzeTopology(repairedMesh);
    buildHighlight();

    addCheckbox(panel, {
      label: '显示修复结果',
      checked: showRepaired,
      onChange: (v) => {
        showRepaired = v;
        render();
      },
    });

    addCheckbox(panel, {
      label: '标出非流形边',
      checked: highlight,
      onChange: (v) => {
        highlight = v;
        render();
      },
    });

    const hint = addHint(panel, '');
    addHint(panel, '红色线段：关联 3 个以上面片的非流形边');

    render();

    return {
      dispose() {
        viewer.removeObject(highlightLines);
        highlightLines = null;
        viewer.disposeMesh();
      },
    };
  },
};
