import { cleanMesh } from '../core/mesh-clean.js';
import { laplacianSmooth } from '../core/mesh-smooth.js';
import { simplifyMesh } from '../core/mesh-simplify.js';
import { analyzeTopology, repairTopology } from '../core/mesh-topology.js';
import { buildObjMesh, buildPlyMesh, parseMeshFile, saveTextFile } from '../core/point-file.js';
import { addButton, addCheckbox, addHint, addSelect, addSlider } from '../core/ui.js';

/**
 * 页面：后处理（串行流程）。
 * 清洗 → 拓扑修复 → 平滑 → 简化 四步按固定顺序依次执行，
 * 每一步可单独开关与调参，运行后可切换查看各阶段结果。
 * 默认不加载数据，通过「选择网格文件…」或拖入 PLY / OBJ 导入（兼容曲面重建的导出）；
 * 结果可导出为 PLY / OBJ，文件名、保存位置与类型都在系统保存对话框内选择。
 */

export default {
  id: 'post',
  title: '后处理',
  description: '清洗 → 拓扑修复 → 平滑 → 简化 串行处理网格，可导入/导出 PLY、OBJ',

  mount({ viewer, panel }) {
    // ---- 流程开关与参数 ----
    let doClean = true;
    let doTopology = true;
    let doSmooth = true;
    let doSimplify = true;

    let areaRatio = 0.02; // 退化面面积阈值（相对平均面积）
    let removeSelfIntersect = true;
    let iterations = 6;
    let featureAngle = 45;
    let taubin = false;
    let targetRatio = 0.5;

    let wireframe = false;
    let previewId = 'final';

    let source = null; // 导入的原始网格
    let final = null; // 流程最终结果
    let stages = []; // 各阶段快照，用于回看

    /** 按预览阶段渲染；fit=true 时顺带重置视角 */
    const render = (fit = false) => {
      const stage = stages.find((s) => s.id === previewId) ?? stages[stages.length - 1];
      if (!stage) return;
      viewer.setMesh(stage.mesh, { color: 0x86bce8, wireframe, flatShading: true });
      viewer.setMeshWireframe(wireframe);
      if (fit) viewer.fitToMesh(1.5);
    };

    /** 串行执行启用的步骤，记录每步统计 */
    const runPipeline = () => {
      if (!source) {
        statsInfo.textContent = '请先导入网格数据';
        return;
      }

      const t0 = performance.now();
      const log = [];
      let current = source;
      stages = [{ id: 'source', label: '原始网格', mesh: source }];

      if (doClean) {
        const r = cleanMesh(current, { areaRatio, removeSelfIntersect });
        current = r.mesh;
        log.push(
          `① 清洗：面 ${r.stats.facesIn} → ${r.stats.facesOut}` +
            `（剔除退化 ${r.stats.degenerate}、自交 ${r.stats.selfIntersect}，翻转 ${r.stats.flipped}）`,
        );
        stages.push({ id: 'clean', label: '清洗后', mesh: current });
      }

      if (doTopology) {
        const r = repairTopology(current);
        const topo = analyzeTopology(r.mesh);
        current = r.mesh;
        log.push(
          `② 拓扑：拆分非流形边 ${r.stats.splitEdges} / 顶点 ${r.stats.splitVertices}，` +
            `非流形边 ${topo.nonManifoldEdges}，流形 ${topo.isManifold ? '是' : '否'}`,
        );
        stages.push({ id: 'topology', label: '拓扑修复后', mesh: current });
      }

      if (doSmooth) {
        const r = laplacianSmooth(current, {
          iterations,
          lambda: 0.5,
          featureAngle,
          preserveFeatures: true,
          tangential: true,
          taubin,
        });
        current = { positions: r.positions, indices: current.indices };
        log.push(`③ 平滑：${iterations} 次，约束特征点 ${r.featureCount} 个`);
        stages.push({ id: 'smooth', label: '平滑后', mesh: current });
      }

      if (doSimplify) {
        const r = simplifyMesh(current, { targetRatio });
        current = { positions: r.positions, indices: r.indices };
        log.push(
          `④ 简化：面 ${r.facesIn} → ${r.facesOut}（保留 ${((r.facesOut / r.facesIn) * 100).toFixed(0)}%）`,
        );
        stages.push({ id: 'simplify', label: '简化后', mesh: current });
      }

      final = current;
      const cost = performance.now() - t0;
      log.push(
        `结果：顶点 ${(final.positions.length / 3).toLocaleString()} · ` +
          `三角形 ${(final.indices.length / 3).toLocaleString()} · 耗时 ${cost.toFixed(0)} ms`,
      );
      statsInfo.textContent = log.join('\n');

      previewId = 'final';
      rebuildStageOptions();
      render(true);
      exportInfo.textContent = '';
    };

    /** 预览下拉的选项随流程启用的步骤变化 */
    const rebuildStageOptions = () => {
      const select = stageRow.select;
      select.replaceChildren();
      for (const stage of stages) {
        const option = document.createElement('option');
        option.value = stage.id;
        option.textContent = stage.label;
        select.appendChild(option);
      }
      const last = stages[stages.length - 1];
      if (!last) return;
      // 「最终结果」指向最后一步，避免与具体阶段重名
      const option = document.createElement('option');
      option.value = 'final';
      option.textContent = `最终结果（${last.label}）`;
      select.appendChild(option);
      select.value = 'final';
    };

    /** 导入网格文件 */
    const loadMesh = (mesh, label) => {
      source = mesh;
      final = null;
      stages = [];
      viewer.disposePoints();
      viewer.setMesh(source, { color: 0xd6dde8, wireframe });
      viewer.fitToMesh(1.5);
      sourceInfo.textContent = `${label} · 顶点 ${(mesh.positions.length / 3).toLocaleString()} · 面 ${(mesh.indices.length / 3).toLocaleString()}`;
      runPipeline();
    };

    /** 导出处理结果：格式可选 PLY / OBJ，可命名并自选保存位置 */
    const exportMesh = async () => {
      if (!final) {
        exportInfo.textContent = '请先运行处理流程再导出';
        return;
      }
      try {
        exportInfo.textContent = '请选择保存位置…';
        const res = await saveTextFile({
          suggestedName: 'mesh-post',
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
              text: () => buildPlyMesh(final.positions, final.indices, 'post-processed mesh'),
            },
            {
              ext: '.obj',
              description: 'OBJ 三角网格',
              text: () => buildObjMesh(final.positions, final.indices, 'post-processed mesh'),
            },
          ],
        });
        exportInfo.textContent = res.saved
          ? `已导出 ${(final.indices.length / 3).toLocaleString()} 个三角形 → ${res.name}` +
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
    fileInput.accept = '.ply,.obj';
    fileInput.style.display = 'none';
    panel.appendChild(fileInput);

    addButton(panel, {
      label: '选择网格文件…',
      onClick: () => fileInput.click(),
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const parsed = await parseMeshFile(file);
        loadMesh({ positions: parsed.positions, indices: parsed.indices }, file.name);
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
        const parsed = await parseMeshFile(file);
        loadMesh({ positions: parsed.positions, indices: parsed.indices }, file.name);
      } catch (err) {
        sourceInfo.textContent = `文件解析失败：${err.message}`;
      }
    };
    viewer.container.addEventListener('dragover', onDragOver);
    viewer.container.addEventListener('drop', onDrop);

    // ---- 流程开关（按执行顺序排列）----
    addCheckbox(panel, {
      label: '① 面片清洗',
      checked: doClean,
      onChange: (v) => {
        doClean = v;
      },
    });
    addSlider(panel, {
      label: '退化面阈值',
      min: 0.005,
      max: 0.05,
      step: 0.005,
      value: areaRatio,
      format: (v) => `${(v * 100).toFixed(1)}%`,
      onInput: (v) => {
        areaRatio = v;
      },
    });
    addCheckbox(panel, {
      label: '剔除自交面片',
      checked: removeSelfIntersect,
      onChange: (v) => {
        removeSelfIntersect = v;
      },
    });

    addCheckbox(panel, {
      label: '② 拓扑修复',
      checked: doTopology,
      onChange: (v) => {
        doTopology = v;
      },
    });

    addCheckbox(panel, {
      label: '③ 拉普拉斯平滑',
      checked: doSmooth,
      onChange: (v) => {
        doSmooth = v;
      },
    });
    addSlider(panel, {
      label: '平滑迭代次数',
      min: 1,
      max: 20,
      step: 1,
      value: iterations,
      format: (v) => String(v),
      onInput: (v) => {
        iterations = v;
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
      },
    });
    addCheckbox(panel, {
      label: 'Taubin 收缩补偿',
      checked: taubin,
      onChange: (v) => {
        taubin = v;
      },
    });

    addCheckbox(panel, {
      label: '④ QEM 网格简化',
      checked: doSimplify,
      onChange: (v) => {
        doSimplify = v;
      },
    });
    addSlider(panel, {
      label: '面数保留比例',
      min: 0.05,
      max: 1,
      step: 0.05,
      value: targetRatio,
      format: (v) => `${(v * 100).toFixed(0)}%`,
      onInput: (v) => {
        targetRatio = v;
      },
    });

    // ---- 预览与执行 ----
    const stageRow = addSelect(panel, {
      label: '预览阶段',
      options: [{ value: 'final', label: '最终结果' }],
      value: 'final',
      onChange: (value) => {
        previewId = value;
        render();
      },
    });

    addCheckbox(panel, {
      label: '显示线框',
      checked: wireframe,
      onChange: (v) => {
        wireframe = v;
        render();
      },
    });

    addButton(panel, {
      label: '运行处理流程',
      onClick: runPipeline,
    });

    addButton(panel, {
      label: '导出网格…',
      onClick: exportMesh,
    });

    const sourceInfo = addHint(panel, '未加载数据：请选择或拖入 PLY / OBJ 网格文件');
    const statsInfo = addHint(panel, '处理流程：清洗 → 拓扑修复 → 平滑 → 简化');
    statsInfo.style.whiteSpace = 'pre-line';
    const exportInfo = addHint(
      panel,
      '参数调整后点击「运行处理流程」生效；导出时把扩展名写成 .ply 或 .obj 即可切换格式',
    );

    return () => {
      viewer.container.removeEventListener('dragover', onDragOver);
      viewer.container.removeEventListener('drop', onDrop);
      viewer.disposeMesh();
      viewer.disposePoints();
      source = null;
      final = null;
      stages = [];
    };
  },
};
