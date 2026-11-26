import { estimateNormals, orientNormalsConsistently } from '../core/normals.js';
import {
  RECON_METHODS,
  ballPivotReconstruct,
  estimateSpacing,
  fastReconstruct,
} from '../core/mesh-recon.js';
import { poissonReconstruct } from '../core/poisson.js';
import {
  SUPPORTED_EXT,
  buildObjMesh,
  buildPlyMesh,
  parsePointFile,
  saveTextFile,
} from '../core/point-file.js';
import { addButton, addCheckbox, addHint, addSelect, addSlider } from '../core/ui.js';

/**
 * 页面：曲面重建。
 * - 默认不加载数据，通过「选择点云文件…」或拖入 PLY / PCD / XYZ 导入
 * - 算法：泊松重建 / BPA 球旋转法 / 空球判据三角化（快速）
 * - 若文件自带法向则直接使用，否则按邻域 PCA 估计并统一朝外（重建前置条件）
 * - 结果可导出为三角网格 PLY / OBJ，文件名、保存位置与类型都在系统保存对话框内选择
 */

const NORMAL_K = 18; // 法向估计邻域点数

export default {
  id: 'reconstruct',
  title: '曲面重建',
  description: '泊松 / BPA 球旋转 / 空球判据快速三角化，点云转三角网格并可导出',

  mount({ viewer, panel }) {
    let method = 'poisson';
    let resolution = 48; // 泊松体素分辨率
    let ballFactor = 1.8; // BPA / 空球判据：球半径 = 平均点间距 × 该系数
    let showMesh = true;
    let showPoints = false;
    let wireframe = false;

    let positions = null;
    let normals = null;
    let spacing = 1;
    let extent = 1;
    let result = null; // { positions, indices, triangles }
    let taskId = 0;
    let timer = null;
    let progressTimer = null;

    /** 取包围盒最大边长，用于点大小等与尺度相关的显示参数 */
    const extentOf = (pos) => {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < pos.length; i += 3) {
        if (pos[i] < minX) minX = pos[i];
        if (pos[i + 1] < minY) minY = pos[i + 1];
        if (pos[i + 2] < minZ) minZ = pos[i + 2];
        if (pos[i] > maxX) maxX = pos[i];
        if (pos[i + 1] > maxY) maxY = pos[i + 1];
        if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
      }
      return Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    };

    /** 用重建结果更新场景中的网格 */
    const renderMesh = () => {
      if (!result) {
        viewer.disposeMesh();
        return;
      }
      viewer.setMesh(result, {
        color: 0x86bce8,
        wireframe,
        flatShading: true,
      });
      viewer.setMeshVisible(showMesh);
    };

    /** 重建：法向准备 → 选定算法 → 生成三角网格 */
    const rebuild = () => {
      if (!positions) {
        info.textContent = '请先导入点云数据';
        return;
      }
      const id = ++taskId;
      startProgress();

      setTimeout(() => {
        if (id !== taskId) return;
        try {
          const t0 = performance.now();
          const nrm = normals ? Float32Array.from(normals) : estimateNormals(positions, { k: NORMAL_K }).normals;
          if (!normals) orientNormalsConsistently(positions, nrm, { k: NORMAL_K, outward: true });

          const radius = spacing * ballFactor;
          if (method === 'poisson') {
            result = poissonReconstruct(positions, nrm, { resolution });
          } else if (method === 'bpa') {
            result = ballPivotReconstruct(positions, nrm, { radius, k: 24 });
          } else {
            result = fastReconstruct(positions, nrm, { radius, k: 12 });
          }
          // 空结果直接提示，避免画面上没有任何反应的"重建不出来"
          if (!result || !result.indices || result.indices.length < 3) {
            throw new Error('未生成三角面，请调高体素分辨率、调大球半径或换用其它算法');
          }

          renderMesh();
          const cost = performance.now() - t0;
          const label = RECON_METHODS.find((m) => m.id === method)?.label ?? method;
          info.textContent =
            `${label} · 顶点 ${(result.positions.length / 3).toLocaleString()} · ` +
            `三角形 ${result.triangles.toLocaleString()} · 耗时 ${cost.toFixed(0)} ms`;
          exportInfo.textContent = '';
          viewer.fitToMesh(1.5);
        } catch (err) {
          result = null;
          viewer.disposeMesh();
          info.textContent = `重建失败：${err.message}`;
        }
        finishProgress();
      }, 60);
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, 180);
    };

    /** 进度条：开始 */
    const startProgress = () => {
      progressBox.classList.add('active');
      progressFill.style.width = '0%';
      requestAnimationFrame(() => {
        progressFill.style.width = '70%';
      });
    };

    /** 进度条：收尾 */
    const finishProgress = () => {
      progressFill.style.width = '100%';
      clearTimeout(progressTimer);
      progressTimer = setTimeout(() => {
        progressBox.classList.remove('active');
        progressFill.style.width = '0%';
      }, 240);
    };

    /** 载入点云：重置状态并立即重建 */
    const loadPositions = (pos, nrm, label) => {
      positions = pos;
      spacing = estimateSpacing(pos);
      extent = extentOf(pos);
      // 文件自带法向时直接使用，并统一朝外；否则留空，重建时再估计
      if (nrm && nrm.length === positions.length) {
        normals = nrm;
        orientNormalsConsistently(positions, normals, { k: NORMAL_K, outward: true });
      } else {
        normals = null;
      }

      viewer.disposeMesh();
      viewer.setPoints(positions, null, {
        size: extent * 0.0006,
        color: 0x4ea1ff,
      });
      viewer.pointsMesh.visible = showPoints;
      result = null;
      sourceInfo.textContent = `${label} · ${(pos.length / 3).toLocaleString()} 点`;
      rebuild();
    };

    /** 导出重建网格：文件名、位置与 PLY / OBJ 类型均在保存对话框内选择 */
    const exportMesh = async () => {
      if (!result) {
        exportInfo.textContent = '请先完成重建再导出';
        return;
      }
      try {
        exportInfo.textContent = '请选择保存位置…';
        const comment = `recon ${method}`;
        const res = await saveTextFile({
          suggestedName: `mesh-recon-${method}`,
          defaultExt: '.ply',
          // 分阶段反馈，用户能看出卡在选位置、生成内容还是写入
          onStage: (stage) => {
            exportInfo.textContent =
              stage === 'writing' ? '正在写入文件…' : stage === 'building' ? '正在生成文件内容…' : '请选择保存位置…';
          },
          formats: [
            {
              ext: '.ply',
              description: 'PLY 三角网格',
              text: () => buildPlyMesh(result.positions, result.indices, comment),
            },
            {
              ext: '.obj',
              description: 'OBJ 三角网格',
              text: () => buildObjMesh(result.positions, result.indices, comment),
            },
          ],
        });
        exportInfo.textContent = res.saved
          ? `已导出 ${result.triangles.toLocaleString()} 个三角形 → ${res.name}` +
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

    // ---- 数据导入 ----
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
        loadPositions(parsed.positions, parsed.normals, file.name);
      } catch (err) {
        sourceInfo.textContent = `文件解析失败：${err.message}`;
      }
      fileInput.value = '';
    });

    const onDragOver = (event) => event.preventDefault();
    const onDrop = async (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      try {
        const parsed = await parsePointFile(file);
        loadPositions(parsed.positions, parsed.normals, file.name);
      } catch (err) {
        sourceInfo.textContent = `文件解析失败：${err.message}`;
      }
    };
    viewer.container.addEventListener('dragover', onDragOver);
    viewer.container.addEventListener('drop', onDrop);

    // ---- 算法与参数 ----
    addSelect(panel, {
      label: '重建算法',
      options: RECON_METHODS.map((m) => ({ value: m.id, label: m.label })),
      value: method,
      onChange: (value) => {
        method = value;
        // 参数含义随算法切换，提示对应说明
        paramHint.textContent =
          value === 'poisson'
            ? '泊松：体素分辨率越高细节越细，耗时随之增加'
            : '球旋转 / 空球判据：球半径约为平均点间距的 1.5~2.5 倍';
        schedule();
      },
    });

    addSlider(panel, {
      label: '体素分辨率',
      min: 32,
      max: 72,
      step: 8,
      value: resolution,
      format: (v) => String(v),
      onInput: (v) => {
        resolution = v;
        schedule();
      },
    });

    addSlider(panel, {
      label: '球半径系数',
      min: 1.2,
      max: 3,
      step: 0.1,
      value: ballFactor,
      format: (v) => `${v.toFixed(1)} × 点间距`,
      onInput: (v) => {
        ballFactor = v;
        schedule();
      },
    });

    addCheckbox(panel, {
      label: '显示网格',
      checked: showMesh,
      onChange: (v) => {
        showMesh = v;
        viewer.setMeshVisible(v);
      },
    });

    addCheckbox(panel, {
      label: '显示原始点云',
      checked: showPoints,
      onChange: (v) => {
        showPoints = v;
        if (viewer.pointsMesh) viewer.pointsMesh.visible = v;
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

    // 进度条 + 重建按钮 + 导出按钮
    const progressBox = document.createElement('div');
    progressBox.className = 'progress';
    const progressFill = document.createElement('div');
    progressFill.className = 'progress-fill';
    progressBox.appendChild(progressFill);
    panel.appendChild(progressBox);

    addButton(panel, {
      label: '重新重建',
      onClick: () => rebuild(),
    });

    addButton(panel, {
      label: '导出网格…',
      onClick: exportMesh,
    });

    const sourceInfo = addHint(panel, '未加载数据：请选择或拖入点云文件');
    const paramHint = addHint(panel, '泊松：体素分辨率越高细节越细，耗时随之增加');
    const info = addHint(panel, '');
    const exportInfo = addHint(
      panel,
      `可加载 ${SUPPORTED_EXT}；导出时在保存对话框里把扩展名写成 .ply 或 .obj 即可切换格式`,
    );

    return () => {
      clearTimeout(timer);
      clearTimeout(progressTimer);
      taskId++;
      viewer.container.removeEventListener('dragover', onDragOver);
      viewer.container.removeEventListener('drop', onDrop);
      viewer.disposeMesh();
      viewer.disposePoints();
      positions = null;
      normals = null;
      result = null;
    };
  },
};
