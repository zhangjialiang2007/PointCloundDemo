import * as THREE from 'three';
import { generateTerrain } from '../core/generators.js';
import { estimateNormals } from '../core/normals.js';
import { addCheckbox, addHint, addSlider } from '../core/ui.js';

/**
 * 示例：邻域 PCA 法向估计。
 * 对每个点取 k 近邻 → 协方差矩阵 → 特征分解，最小特征向量为法向，
 * λ0/(λ0+λ1+λ2) 作为曲率用于着色。
 * 每个点绘制一个切平面小面片（面片所在平面垂直于估计法向），并绘制部分法向线。
 */

const POINT_COUNT = 40000;
const LINE_STEP = 3; // 每隔若干个点绘制一根法向线，控制线段数量
const VERTS_PER_PATCH = 6; // 每个面片 2 个三角形

export default {
  id: 'normals',
  title: '法向估计 (PCA)',
  description: 'k 邻域协方差特征分解估计法向，按曲率着色，切平面面片垂直于估计法向',

  mount({ viewer, panel }) {
    let k = 16;
    let patchSize = 0.014;
    let normalLength = 0.08;
    let showNormals = true;

    let positions = null;
    let normals = null;
    let colors = null; // 每点曲率颜色
    let pointCount = 0;
    let sampleIdx = null; // 参与绘制法向线的点索引
    let linePositions = null; // 线段顶点（起点 + 终点）
    let lineMesh = null;
    let patchGeometry = null; // 面片几何（位置 + 颜色属性复用）
    let patchMesh = null;
    let timer = null;

    /** 按曲率着色：平坦（蓝）→ 起伏（红），开方压缩使弱起伏也可见 */
    const colorByCurvature = (curvatures) => {
      const colors = new Float32Array(curvatures.length * 3);
      let max = 0;
      for (let i = 0; i < curvatures.length; i++) {
        if (curvatures[i] > max) max = curvatures[i];
      }
      const denom = max > 0 ? max : 1;
      const color = new THREE.Color();

      for (let i = 0; i < curvatures.length; i++) {
        const t = Math.min(1, Math.sqrt(curvatures[i] / denom));
        color.setHSL(0.6 * (1 - t), 0.85, 0.55);
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      return colors;
    };

    /**
     * 填充切平面面片顶点：以法向为面片法线，在法向的垂直平面内取正交基 u、v，
     * 四个角点为 p ± u ± v，拆成两个三角形（每点 6 个顶点）。
     */
    const fillPatchPositions = (updateBounds = false) => {
      const attr = patchGeometry?.attributes.position;
      if (!attr) return;

      const arr = attr.array;
      const h = patchSize * 0.5;

      for (let i = 0; i < pointCount; i++) {
        const px = positions[i * 3];
        const py = positions[i * 3 + 1];
        const pz = positions[i * 3 + 2];
        const nx = normals[i * 3];
        const ny = normals[i * 3 + 1];
        const nz = normals[i * 3 + 2];

        // 取与法向最不平行的坐标轴做辅助向量，叉乘得到切平面内的基向量 u
        const ax = Math.abs(nx);
        const ay = Math.abs(ny);
        const az = Math.abs(nz);
        let rx = 0;
        let ry = 0;
        let rz = 0;
        if (ax <= ay && ax <= az) rx = 1;
        else if (ay <= az) ry = 1;
        else rz = 1;

        let ux = ry * nz - rz * ny;
        let uy = rz * nx - rx * nz;
        let uz = rx * ny - ry * nx;
        const ul = Math.hypot(ux, uy, uz);
        if (ul > 0) {
          ux = (ux / ul) * h;
          uy = (uy / ul) * h;
          uz = (uz / ul) * h;
        }

        // v = n × u，同样位于切平面内且与 u 正交，长度同为 h
        const vx = ny * uz - nz * uy;
        const vy = nz * ux - nx * uz;
        const vz = nx * uy - ny * ux;

        // 四个角点：(-u-v) (+u-v) (+u+v) (-u+v)
        const c0x = px - ux - vx, c0y = py - uy - vy, c0z = pz - uz - vz;
        const c1x = px + ux - vx, c1y = py + uy - vy, c1z = pz + uz - vz;
        const c2x = px + ux + vx, c2y = py + uy + vy, c2z = pz + uz + vz;
        const c3x = px - ux + vx, c3y = py - uy + vy, c3z = pz - uz + vz;

        const o = i * VERTS_PER_PATCH * 3;
        arr[o] = c0x; arr[o + 1] = c0y; arr[o + 2] = c0z;
        arr[o + 3] = c1x; arr[o + 4] = c1y; arr[o + 5] = c1z;
        arr[o + 6] = c2x; arr[o + 7] = c2y; arr[o + 8] = c2z;
        arr[o + 9] = c0x; arr[o + 10] = c0y; arr[o + 11] = c0z;
        arr[o + 12] = c2x; arr[o + 13] = c2y; arr[o + 14] = c2z;
        arr[o + 15] = c3x; arr[o + 16] = c3y; arr[o + 17] = c3z;
      }

      attr.needsUpdate = true;
      if (updateBounds) patchGeometry.computeBoundingSphere();
    };

    /** 面片顶点颜色取该点的曲率颜色 */
    const fillPatchColors = () => {
      const attr = patchGeometry?.attributes.color;
      if (!attr) return;

      const arr = attr.array;
      for (let i = 0; i < pointCount; i++) {
        const r = colors[i * 3];
        const g = colors[i * 3 + 1];
        const b = colors[i * 3 + 2];
        const o = i * VERTS_PER_PATCH * 3;
        for (let v = 0; v < VERTS_PER_PATCH * 3; v += 3) {
          arr[o + v] = r;
          arr[o + v + 1] = g;
          arr[o + v + 2] = b;
        }
      }
      attr.needsUpdate = true;
    };

    /** 创建（或重建）切平面面片对象 */
    const createPatches = () => {
      viewer.removeObject(patchMesh);
      patchMesh = null;
      patchGeometry = null;

      const vertexCount = pointCount * VERTS_PER_PATCH;
      patchGeometry = new THREE.BufferGeometry();
      patchGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
      patchGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));

      patchMesh = new THREE.Mesh(
        patchGeometry,
        new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      );
      viewer.addObject(patchMesh);
    };

    /** 依据当前法向与长度填充线段顶点 */
    const fillLinePositions = () => {
      if (!lineMesh) return;
      for (let s = 0; s < sampleIdx.length; s++) {
        const i = sampleIdx[s];
        const o = s * 6;
        const px = positions[i * 3];
        const py = positions[i * 3 + 1];
        const pz = positions[i * 3 + 2];

        linePositions[o] = px;
        linePositions[o + 1] = py;
        linePositions[o + 2] = pz;
        linePositions[o + 3] = px + normals[i * 3] * normalLength;
        linePositions[o + 4] = py + normals[i * 3 + 1] * normalLength;
        linePositions[o + 5] = pz + normals[i * 3 + 2] * normalLength;
      }
      lineMesh.geometry.attributes.position.needsUpdate = true;
      lineMesh.geometry.computeBoundingSphere();
    };

    /** 创建（或重建）法向线段对象 */
    const createLines = () => {
      viewer.removeObject(lineMesh);
      lineMesh = null;

      const total = positions.length / 3;
      const sampleCount = Math.ceil(total / LINE_STEP);
      sampleIdx = new Int32Array(sampleCount);
      linePositions = new Float32Array(sampleCount * 6);
      for (let s = 0; s < sampleCount; s++) sampleIdx[s] = s * LINE_STEP;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));

      lineMesh = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({
          color: 0x9fd8ff,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        }),
      );
      lineMesh.visible = showNormals;
      viewer.addObject(lineMesh);
      fillLinePositions();
    };

    /** 重新生成点云并做一次法向估计 */
    const rebuild = () => {
      positions = generateTerrain(POINT_COUNT, 4);
      pointCount = positions.length / 3;

      const t0 = performance.now();
      const result = estimateNormals(positions, { k });
      const cost = performance.now() - t0;
      normals = result.normals;
      colors = colorByCurvature(result.curvatures);

      // 点数固定，面片对象只需创建一次；之后只更新顶点数据
      if (!patchMesh) createPatches();
      fillPatchPositions(true);
      fillPatchColors();
      createLines();
      viewer.fitToObject(patchMesh, 1.4);

      hint.textContent = `${(POINT_COUNT / 1000).toFixed(0)}k 点 · k=${k} · PCA 耗时 ${cost.toFixed(0)} ms`;
    };

    /** 拖动 k 滑块时防抖，避免连续触发重算 */
    const scheduleRebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, 120);
    };

    let patchFrame = 0;
    /** 面片尺寸变化合并到下一帧执行，避免连续拖动时每帧多次填充 */
    const schedulePatchUpdate = () => {
      if (patchFrame) return;
      patchFrame = requestAnimationFrame(() => {
        patchFrame = 0;
        fillPatchPositions();
      });
    };

    addSlider(panel, {
      label: '邻域点数 k',
      min: 4,
      max: 40,
      step: 1,
      value: k,
      format: (v) => String(v),
      onInput: (v) => {
        k = v;
        scheduleRebuild();
      },
    });

    addSlider(panel, {
      label: '面片尺寸',
      min: 0.004,
      max: 0.04,
      step: 0.001,
      value: patchSize,
      format: (v) => v.toFixed(3),
      onInput: (v) => {
        patchSize = v;
        schedulePatchUpdate();
      },
    });

    addSlider(panel, {
      label: '法向长度',
      min: 0.02,
      max: 0.25,
      step: 0.01,
      value: normalLength,
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        normalLength = v;
        fillLinePositions();
      },
    });

    addCheckbox(panel, {
      label: '显示法向线',
      checked: showNormals,
      onChange: (checked) => {
        showNormals = checked;
        if (lineMesh) lineMesh.visible = checked;
      },
    });

    const hint = addHint(panel, '');
    addHint(panel, '面片平面垂直于估计法向；颜色：平坦（蓝）→ 起伏（红）');

    rebuild();

    return {
      dispose() {
        clearTimeout(timer);
        if (patchFrame) cancelAnimationFrame(patchFrame);
        viewer.removeObject(lineMesh);
        lineMesh = null;
        viewer.removeObject(patchMesh); // 释放面片几何与材质
        patchMesh = null;
        patchGeometry = null;
        viewer.disposePoints();
      },
    };
  },
};
