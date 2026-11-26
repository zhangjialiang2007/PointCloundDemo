# 点云演示工程

基于 Vite + Three.js 的点云处理与可视化演示，纯 JavaScript（ES Module），无框架。

## 使用

```bash
npm install
npm run dev      # 本地开发，默认 http://localhost:5173
npm run build    # 生产构建到 dist/
npm run preview  # 预览构建结果
```

## 目录结构

```
index.html              页面骨架（侧边栏 + 视口 + 参数面板）
src/
  main.js               入口：注册示例、切换示例、hash 路由
  style.css             整体样式
  core/
    viewer.js           PointCloudViewer：场景/相机/控制器/渲染循环封装
    generators.js       程序化点云：起伏球
    ui.js               参数面板控件（滑块、复选、下拉、按钮、提示）
    normals.js          法向估计：PCA / RANSAC / ROBPCA(MCD) / Hough / 邻域自适应 / 漂移邻域
    point-file.js       点云文件读写：PLY/PCD/XYZ 解析、导出带法向 PLY
    poisson.js          泊松曲面重建主流程
    poisson-solver.js   法向散布、散度、共轭梯度求解、上采样
    marching-tet.js     行进四面体等值面提取
    mesh.js             网格工具：邻点/边-面表、法向、起伏球面网格
    mesh-defects.js     缺陷注入：退化三角、自交面片、翻面、孤立薄片
    mesh-clean.js       退化/自交检测、面片剔除、法向统一
    mesh-smooth.js      拉普拉斯平滑（特征点约束、Taubin 补偿）
    mesh-simplify.js    QEM 边折叠网格简化
    mesh-topology.js    拓扑统计与流形修复（拆分非流形边/顶点）
  demos/
    index.js            示例注册表
    normals.js          示例：法向估计（含点云加载与 PLY 导出）
    poisson.js          示例：泊松曲面重建
    mesh-clean.js       示例：面片清洗
    mesh-smooth.js      示例：网格平滑
    mesh-simplify.js    示例：网格简化
    mesh-topology.js    示例：修复拓扑
data/
  normals-terrain.xyz   起伏地形点云（原 PCA 示例程序化生成，40000 点，可手动拖入法向示例）
  point_cloud.ply       内置测试数据：带噪声与离群点的球面点云
```

法向估计示例默认不加载任何数据，可通过「选择点云文件…」或直接拖入本地 PLY / PCD / XYZ 文件；
估计完成后通过「导出 PLY（含法向）」输出带法向点云，可直接用于泊松重建。

## 新增示例

1. 在 `src/demos/` 下新建文件，默认导出一个对象：

```js
export default {
  id: 'my-demo',
  title: '示例名称',
  description: '一句话说明',
  mount({ viewer, panel }) {
    viewer.setPoints(positions, colors, { size: 0.01 });
    viewer.fitToPoints();
    return {
      dispose() {
        viewer.disposePoints();
      },
    };
  },
};
```

2. 在 `src/demos/index.js` 中导入并加入 `demos` 数组。

`viewer` 提供 `setPoints / setPointSize / fitToPoints / setHelpersVisible / disposePoints`；
网格类示例另有 `setMesh / setMeshWireframe / setMeshVisible / fitToMesh / disposeMesh`；
`panel` 为参数面板容器，可配合 `core/ui.js` 的 `addSlider`、`addCheckbox`、`addSelect`、`addButton`、`addHint` 使用。
