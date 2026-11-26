import * as THREE from 'three';
import { generateBlob } from '../core/generators.js';
import { estimateNormals } from '../core/normals.js';
import { poissonReconstruct } from '../core/poisson.js';
import { addCheckbox, addHint, addSlider } from '../core/ui.js';

/**
 * 示例：泊松曲面重建。
 * 定向点云 → 法向散布成向量场 → 解泊松方程 → 行进四面体提取等值面。
 */

const POINT_COUNT = 20000;
const KNN = 20;

/** 让法向朝外（以质心为参考），这是泊松重建的前置条件 */
function orientOutward(positions, normals) {
  const n = positions.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += positions[i * 3];
    cy += positions[i * 3 + 1];
    cz += positions[i * 3 + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;

  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    if (normals[i * 3] * dx + normals[i * 3 + 1] * dy + normals[i * 3 + 2] * dz < 0) {
      normals[i * 3] *= -1;
      normals[i * 3 + 1] *= -1;
      normals[i * 3 + 2] *= -1;
    }
  }
}

export default {
  id: 'poisson',
  title: '泊松曲面重建',
  description: '定向点云经泊松方程求解与行进四面体提取，生成三角网格',

  mount({ viewer, panel }) {
    // 点云数据固定，重建时只更换网格
    const positions = generateBlob(POINT_COUNT, 1);
    let mesh = null;
    let resolution = 48;
    let showMesh = true;
    let showPoints = true;
    let taskId = 0; // 防止上一次重建结果覆盖新结果

    const meshInfo = addHint(panel, '');

    /** 用重建结果更新场景中的网格 */
    const updateMesh = (result) => {
      viewer.removeObject(mesh);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
      geometry.computeVertexNormals();

      mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: 0x86bce8,
          roughness: 0.55,
          metalness: 0.05,
          flatShading: true,
          side: THREE.DoubleSide,
        }),
      );
      viewer.addObject(mesh);
    };

    /** 重建：法向估计 + 泊松求解 + 等值面提取 */
    const rebuild = () => {
      const id = ++taskId;
      meshInfo.textContent = '计算中…';

      // 先让提示渲染出来，再执行同步计算
      setTimeout(() => {
        if (id !== taskId) return;
        try {
          const t0 = performance.now();
          const { normals } = estimateNormals(positions, { k: KNN });
          orientOutward(positions, normals);

          const result = poissonReconstruct(positions, normals, { resolution });
          updateMesh(result);
          mesh.visible = showMesh;

          const cost = performance.now() - t0;
          meshInfo.textContent = `三角形 ${result.triangles.toLocaleString()} 个 · 耗时 ${cost.toFixed(0)} ms`;
          viewer.fitToPoints(1.5);
        } catch (err) {
          meshInfo.textContent = `重建失败：${err.message}`;
        }
      }, 0);
    };

    // ---- 场景初始化：原始点云 + 首次重建 ----
    viewer.setPoints(positions, null, { size: 0.006, color: 0x4ea1ff });

    addSlider(panel, {
      label: '网格分辨率',
      min: 32,
      max: 64,
      step: 16,
      value: resolution,
      format: (v) => String(v),
      onInput: (v) => {
        resolution = v;
        rebuild();
      },
    });

    addCheckbox(panel, {
      label: '显示网格',
      checked: showMesh,
      onChange: (checked) => {
        showMesh = checked;
        if (mesh) mesh.visible = checked;
      },
    });

    addCheckbox(panel, {
      label: '显示点云',
      checked: showPoints,
      onChange: (checked) => {
        showPoints = checked;
        if (viewer.pointsMesh) viewer.pointsMesh.visible = checked;
      },
    });

    addHint(panel, `${(POINT_COUNT / 1000).toFixed(0)}k 点 · k=${KNN} 邻域法向`);

    rebuild();

    return {
      dispose() {
        taskId++;
        viewer.removeObject(mesh);
        mesh = null;
        viewer.disposePoints();
      },
    };
  },
};
