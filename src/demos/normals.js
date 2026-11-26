import * as THREE from 'three';
import { NORMAL_METHODS, estimateNormals, orientNormalsConsistently } from '../core/normals.js';
import {
  SUPPORTED_EXT,
  buildPlyWithNormals,
  buildXyzWithNormals,
  parsePointFile,
  saveTextFile,
} from '../core/point-file.js';
import { addButton, addCheckbox, addColorBand, addHint, addSelect, addSlider } from '../core/ui.js';

/**
 * 示例：法向估计（含点云文件加载与导出）。
 * - 默认不加载任何数据：选择或拖入本地 PLY / PCD / XYZ 文件
 * - 六种算法：PCA / RANSAC / ROBPCA(MCD) / Hough / 邻域自适应 / 漂移邻域
 * - 法向先沿 kNN 图传播统一方向，再按「法向朝外」整体定向（显示与导出一致）
 * - 每个点绘制垂直于法向的切平面面片，可叠加法向线；两者按法向与 +Y 的夹角在多色标色带内取色
 * - 重算时进度条提示并先隐藏旧法向
 * - 可导出带法向的 PLY / XYZ，文件名、保存位置与类型都在系统保存对话框内选择
 */

const LINE_STEP = 3; // 每隔若干个点绘制一根法向线，控制线段数量
const VERTS_PER_PATCH = 6; // 每个面片 2 个三角形

/** 取点云包围盒最大边长，用于把显示尺寸参数换算成与数据尺度无关的百分比 */
function dataExtentOf(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
}

export default {
  id: 'normals',
  title: '法向估计',
  description: 'PCA / RANSAC / ROBPCA(MCD) / Hough / 自适应邻域 / 漂移邻域，可加载点云并导出带法向 PLY',

  mount({ viewer, panel }) {
    let method = 'pca';
    let k = 16;
    let patchPct = 0.35; // 面片尺寸占数据尺度的百分比
    let normalPct = 2; // 法向线长度占数据尺度的百分比
    let pointPct = 0.12; // 点大小占数据尺度的百分比
    // 色带：法向与 +Y 夹角 0°→180° 依次取这些色标（多段渐变，可设置）
    const bandStops = ['#2b6cff', '#22d3c5', '#ffd93b', '#ff3b30'];
    let showNormals = true;
    let outward = true; // 法向朝外：显示与导出使用同一套方向

    const bandColors = bandStops.map((hex) => new THREE.Color(hex));
    const bandColor = new THREE.Color(); // 复用的取色临时变量

    /** 角度 t∈[0,1]（0 朝上、1 朝下）在色带上插值取色 */
    const sampleBandColor = (t) => {
      const n = bandColors.length;
      const x = Math.min(n - 1.000001, Math.max(0, t)) * (n - 1);
      const i = Math.floor(x);
      return bandColor.copy(bandColors[i]).lerp(bandColors[i + 1], x - i);
    };

    /** 该点法向与 +Y 的夹角归一化：0 = 朝上，1 = 朝下 */
    const angleT = (i) => {
      const ny = normals[i * 3 + 1];
      return Math.acos(ny < -1 ? -1 : ny > 1 ? 1 : ny) / Math.PI;
    };

    let positions = null;
    let normals = null;
    let colors = null; // 每点曲率颜色
    let pointCount = 0;
    let extent = 1;
    let sampleIdx = null; // 参与绘制法向线的点索引
    let linePositions = null; // 线段顶点（起点 + 终点）
    let lineMesh = null;
    let patchGeometry = null; // 面片几何（位置 + 颜色属性复用）
    let patchMesh = null;
    let timer = null;
    let progressTimer = null;

    const patchSize = () => extent * (patchPct / 100);
    const normalLength = () => extent * (normalPct / 100);
    const pointSize = () => extent * (pointPct / 100);

    /** 按曲率着色：平坦（蓝）→ 起伏（红），开方压缩使弱起伏也可见 */
    const colorByCurvature = (curvatures) => {
      const out = new Float32Array(curvatures.length * 3);
      let max = 0;
      for (let i = 0; i < curvatures.length; i++) {
        if (curvatures[i] > max) max = curvatures[i];
      }
      const denom = max > 0 ? max : 1;
      const color = new THREE.Color();

      for (let i = 0; i < curvatures.length; i++) {
        const t = Math.min(1, Math.sqrt(curvatures[i] / denom));
        color.setHSL(0.6 * (1 - t), 0.85, 0.55);
        out[i * 3] = color.r;
        out[i * 3 + 1] = color.g;
        out[i * 3 + 2] = color.b;
      }
      return out;
    };

    /**
     * 填充切平面面片顶点：以法向为面片法线，在法向的垂直平面内取正交基 u、v，
     * 四个角点为 p ± u ± v，拆成两个三角形（每点 6 个顶点）。
     */
    const fillPatchPositions = (updateBounds = false) => {
      const attr = patchGeometry?.attributes.position;
      if (!attr) return;

      const arr = attr.array;
      const h = patchSize() * 0.5;

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

    /** 面片顶点颜色取该点法向夹角在色带中的颜色 */
    const fillPatchColors = () => {
      const attr = patchGeometry?.attributes.color;
      if (!attr) return;

      const arr = attr.array;
      for (let i = 0; i < pointCount; i++) {
        sampleBandColor(angleT(i));
        const o = i * VERTS_PER_PATCH * 3;
        for (let v = 0; v < VERTS_PER_PATCH * 3; v += 3) {
          arr[o + v] = bandColor.r;
          arr[o + v + 1] = bandColor.g;
          arr[o + v + 2] = bandColor.b;
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
      const len = normalLength();
      for (let s = 0; s < sampleIdx.length; s++) {
        const i = sampleIdx[s];
        const o = s * 6;
        const px = positions[i * 3];
        const py = positions[i * 3 + 1];
        const pz = positions[i * 3 + 2];

        linePositions[o] = px;
        linePositions[o + 1] = py;
        linePositions[o + 2] = pz;
        linePositions[o + 3] = px + normals[i * 3] * len;
        linePositions[o + 4] = py + normals[i * 3 + 1] * len;
        linePositions[o + 5] = pz + normals[i * 3 + 2] * len;
      }
      lineMesh.geometry.attributes.position.needsUpdate = true;
      lineMesh.geometry.computeBoundingSphere();
    };

    /** 法向线顶点颜色同样取该点法向在色带中的颜色 */
    const fillLineColors = () => {
      const attr = lineMesh?.geometry.attributes.color;
      if (!attr) return;

      const arr = attr.array;
      for (let s = 0; s < sampleIdx.length; s++) {
        const i = sampleIdx[s];
        sampleBandColor(angleT(i));
        const o = s * 6; // 线段两端同色
        arr[o] = bandColor.r;
        arr[o + 1] = bandColor.g;
        arr[o + 2] = bandColor.b;
        arr[o + 3] = bandColor.r;
        arr[o + 4] = bandColor.g;
        arr[o + 5] = bandColor.b;
      }
      attr.needsUpdate = true;
    };

    /** 创建（或重建）法向线段对象 */
    const createLines = () => {
      viewer.removeObject(lineMesh);
      lineMesh = null;

      const sampleCount = Math.ceil(pointCount / LINE_STEP);
      sampleIdx = new Int32Array(sampleCount);
      linePositions = new Float32Array(sampleCount * 6);
      for (let s = 0; s < sampleCount; s++) sampleIdx[s] = s * LINE_STEP;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(sampleCount * 6), 3));

      lineMesh = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        }),
      );
      lineMesh.visible = showNormals;
      viewer.addObject(lineMesh);
      fillLinePositions();
      fillLineColors();
    };

    /** 对当前点云做一次法向估计并刷新可视化 */
    const estimate = (doFit = false) => {
      if (!positions) return;

      const t0 = performance.now();
      const result = estimateNormals(positions, { k, method });
      normals = result.normals;
      // 沿 kNN 图传播让全片法向方向一致，再按 outward 统一朝外 / 朝内
      orientNormalsConsistently(positions, normals, { k, outward });
      const cost = performance.now() - t0;

      colors = colorByCurvature(result.curvatures);

      viewer.setPoints(positions, colors, { size: pointSize() });

      if (!patchMesh || patchGeometry.attributes.position.count !== pointCount * VERTS_PER_PATCH) {
        createPatches();
      }
      fillPatchPositions(true);
      fillPatchColors();
      createLines();
      if (doFit) viewer.fitToObject(patchMesh, 1.4);

      const label = NORMAL_METHODS.find((m) => m.id === method)?.label ?? method;
      hint.textContent = `${pointCount.toLocaleString()} 点 · k=${k} · ${label} · 耗时 ${cost.toFixed(0)} ms`;
      exportInfo.textContent = '';
    };

    /** 进度条：开始（计算同步阻塞，先让浏览器把进度画出来） */
    const startProgress = () => {
      progressBox.classList.add('active');
      progressFill.style.width = '0%';
      requestAnimationFrame(() => {
        progressFill.style.width = '70%';
      });
    };

    /** 进度条：收尾（到 100% 后淡出） */
    const finishProgress = () => {
      progressFill.style.width = '100%';
      clearTimeout(progressTimer);
      progressTimer = setTimeout(() => {
        progressBox.classList.remove('active');
        progressFill.style.width = '0%';
      }, 240);
    };

    /** 重算入口：先隐藏旧法向线 → 进度条 → 同步估计 → 显示新结果 */
    const runEstimate = (doFit = false) => {
      if (!positions) return;
      if (lineMesh) lineMesh.visible = false;
      startProgress();
      setTimeout(() => {
        estimate(doFit);
        finishProgress();
      }, 90);
    };

    /** 参数变化后延迟重算，避免拖动滑块时反复触发 */
    const scheduleEstimate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => runEstimate(), 60);
    };

    /** 换一份数据：重置尺度与法向，重新估计 */
    const loadPositions = (pos, label) => {
      positions = pos;
      pointCount = pos.length / 3;
      extent = dataExtentOf(pos);
      runEstimate(true);
      sourceInfo.textContent = `${label} · ${pointCount.toLocaleString()} 点`;
    };

    /** 全部法向取反（朝外 ⇄ 朝内） */
    const flipNormals = () => {
      for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
    };

    /** 方向改变后刷新面片与法向线的显示（面片几何与法向符号无关，只需重填颜色） */
    const refreshDirections = () => {
      if (!normals) return;
      fillPatchColors();
      fillLinePositions();
      fillLineColors();
    };

    /** 导出带法向的点云：文件名、位置与 PLY / XYZ 类型均在保存对话框内选择 */
    const exportCloud = async () => {
      if (!positions || !normals) {
        exportInfo.textContent = '请先载入点云并完成法向估计';
        return;
      }
      try {
        exportInfo.textContent = '请选择保存位置…';
        const comment = `normals ${method} k=${k}`;
        const res = await saveTextFile({
          suggestedName: 'pointcloud-normals',
          defaultExt: '.ply',
          // 分阶段反馈，用户能看出卡在选位置、生成内容还是写入
          onStage: (stage) => {
            exportInfo.textContent =
              stage === 'writing' ? '正在写入文件…' : stage === 'building' ? '正在生成文件内容…' : '请选择保存位置…';
          },
          formats: [
            {
              ext: '.ply',
              description: 'PLY 点云（含法向）',
              text: () => buildPlyWithNormals(positions, normals, comment),
            },
            {
              ext: '.xyz',
              description: 'XYZ 文本（含法向）',
              text: () => buildXyzWithNormals(positions, normals, comment),
            },
            {
              ext: '.txt',
              description: 'TXT 文本（含法向）',
              text: () => buildXyzWithNormals(positions, normals, comment),
            },
          ],
        });
        exportInfo.textContent = res.saved
          ? `已导出 ${pointCount.toLocaleString()} 点（法向${outward ? '朝外' : '朝内'}）→ ${res.name}` +
            (res.via === 'download'
              ? res.reason
                ? `（${res.reason}，已改存到浏览器下载目录）`
                : '（已回退为浏览器下载，见下载目录）'
              : '')
          : '已取消导出';
      } catch (err) {
        exportInfo.textContent = `导出失败：${err.message || err}`;
      }
    };

    // ---- 数据来源 ----
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.ply,.pcd,.xyz,.asc,.txt';
    fileInput.style.display = 'none';
    panel.appendChild(fileInput);

    addButton(panel, {
      label: '选择点云文件…',
      onClick: () => fileInput.click(),
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const parsed = await parsePointFile(file);
        loadPositions(parsed.positions, file.name);
      } catch (err) {
        sourceInfo.textContent = `文件解析失败：${err.message}`;
      }
      fileInput.value = '';
    });

    // 点击画布外的拖拽区域也能加载文件
    const onDragOver = (event) => event.preventDefault();
    const onDrop = async (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      try {
        const parsed = await parsePointFile(file);
        loadPositions(parsed.positions, file.name);
      } catch (err) {
        sourceInfo.textContent = `文件解析失败：${err.message}`;
      }
    };
    viewer.container.addEventListener('dragover', onDragOver);
    viewer.container.addEventListener('drop', onDrop);

    // ---- 算法与参数 ----
    addSelect(panel, {
      label: '算法',
      options: NORMAL_METHODS.map((m) => ({ value: m.id, label: m.label })),
      value: method,
      onChange: (value) => {
        method = value;
        scheduleEstimate();
      },
    });

    addSlider(panel, {
      label: '邻域点数 k',
      min: 6,
      max: 48,
      step: 1,
      value: k,
      format: (v) => String(v),
      onInput: (value) => {
        k = value;
        scheduleEstimate();
      },
    });

    addSlider(panel, {
      label: '面片尺寸',
      min: 0.1,
      max: 2,
      step: 0.05,
      value: patchPct,
      format: (v) => `${v.toFixed(2)}%`,
      onInput: (value) => {
        patchPct = value;
        fillPatchPositions(true);
      },
    });

    addSlider(panel, {
      label: '法向长度',
      min: 0.5,
      max: 5,
      step: 0.1,
      value: normalPct,
      format: (v) => `${v.toFixed(1)}%`,
      onInput: (value) => {
        normalPct = value;
        fillLinePositions();
      },
    });

    addSlider(panel, {
      label: '点大小',
      min: 0.05,
      max: 1,
      step: 0.01,
      value: pointPct,
      format: (v) => `${v.toFixed(2)}%`,
      onInput: (value) => {
        pointPct = value;
        viewer.setPointSize(pointSize());
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

    // ---- 色带（面片与法向线按法向夹角取色，位于导出按钮上方）----
    addColorBand(panel, {
      label: '色带（朝上 → 朝下）',
      values: bandStops,
      onChange: (values) => {
        for (let i = 0; i < bandColors.length; i++) bandColors[i].set(values[i]);
        refreshDirections();
      },
    });

    // ---- 导出 ----
    addCheckbox(panel, {
      label: '法向朝外（显示与导出）',
      checked: outward,
      onChange: (checked) => {
        outward = checked;
        exportInfo.textContent = '';
        if (!normals) return;
        flipNormals();
        refreshDirections();
      },
    });

    // 模拟进度条：切换算法 / 参数时短暂显示
    const progressBox = document.createElement('div');
    progressBox.className = 'progress';
    const progressFill = document.createElement('div');
    progressFill.className = 'progress-fill';
    progressBox.appendChild(progressFill);
    panel.appendChild(progressBox);

    addButton(panel, {
      label: '导出点云…',
      onClick: exportCloud,
    });

    const sourceInfo = addHint(panel, '未加载数据：请选择或拖入点云文件');
    const hint = addHint(panel, '');
    const exportInfo = addHint(
      panel,
      `可加载 ${SUPPORTED_EXT}；导出时把扩展名写成 .ply / .xyz / .txt 即可切换格式`,
    );

    return () => {
      clearTimeout(timer);
      clearTimeout(progressTimer);
      viewer.container.removeEventListener('dragover', onDragOver);
      viewer.container.removeEventListener('drop', onDrop);
      viewer.removeObject(patchMesh);
      viewer.removeObject(lineMesh);
      patchMesh = null;
      patchGeometry = null;
      lineMesh = null;
      positions = null;
      normals = null;
      colors = null;
    };
  },
};
