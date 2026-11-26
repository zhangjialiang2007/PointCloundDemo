import { PointCloudViewer } from './core/viewer.js';
import { demos } from './demos/index.js';

const listEl = document.getElementById('demo-list');
const panelEl = document.getElementById('panel');
const viewportEl = document.getElementById('viewport');

const viewer = new PointCloudViewer(viewportEl);
let activeDemo = null;

/** 生成侧边栏按钮 */
for (const demo of demos) {
  const btn = document.createElement('button');
  btn.textContent = demo.title;
  btn.title = demo.description;
  btn.dataset.id = demo.id;
  btn.addEventListener('click', () => activate(demo.id));
  listEl.appendChild(btn);
}

/** 切换到指定示例：清理上一个示例的状态后重新挂载 */
function activate(id) {
  const demo = demos.find((d) => d.id === id) ?? demos[0];
  if (activeDemo?.instance) activeDemo.instance.dispose?.();

  activeDemo = { demo, instance: null };
  panelEl.replaceChildren();
  viewer.disposePoints();
  viewer.disposeMesh();

  // 高亮当前项
  for (const btn of listEl.children) {
    btn.classList.toggle('active', btn.dataset.id === demo.id);
  }

  // 面板标题
  const title = document.createElement('h2');
  title.textContent = demo.title;
  title.title = demo.description;
  panelEl.appendChild(title);

  activeDemo.instance = demo.mount({ viewer, panel: panelEl });
  location.hash = demo.id;
}

// 支持通过 URL hash 直接定位示例
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== activeDemo?.demo.id) activate(id);
});

activate(location.hash.slice(1) || demos[0].id);
