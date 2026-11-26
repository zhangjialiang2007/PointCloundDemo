import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * 点云查看器：封装场景、相机、渲染循环与常用辅助对象。
 * 每个示例只关心"渲染什么数据"，不重复搭建渲染环境。
 */
export class PointCloudViewer {
  constructor(container) {
    this.container = container;

    // 渲染器
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    // 场景与背景
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1116);

    // 相机
    this.camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      0.01,
      10000,
    );
    this.camera.position.set(3, 2.2, 4);

    // 轨道控制
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // 辅助对象：网格 + 坐标轴，便于观察方位
    this.grid = new THREE.GridHelper(10, 10, 0x2a3442, 0x1b222c);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.8;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(1);
    this.scene.add(this.axes);

    // 光照：供网格类示例（如曲面重建）使用，对点云渲染无影响
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x1b2430, 1.6));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(3, 5, 4);
    this.scene.add(keyLight);

    // 点云/网格对象容器（每个示例复用，避免重复创建）
    this.pointsMesh = null;
    this.meshObject = null;
    this.wireObject = null;

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    // 渲染循环
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  /**
   * 用给定的点数据更新点云。
   * @param {Float32Array} positions 顶点坐标 [x,y,z, ...]
   * @param {Float32Array|null} colors 顶点颜色（0~1）[r,g,b, ...]，为空则使用纯色
   * @param {object} options size / color
   */
  setPoints(positions, colors = null, { size = 0.02, color = 0x4ea1ff } = {}) {
    this.disposePoints();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (colors) {
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    geometry.computeBoundingSphere();

    const material = new THREE.PointsMaterial({
      size,
      color: colors ? 0xffffff : color,
      vertexColors: Boolean(colors),
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
    });

    this.pointsMesh = new THREE.Points(geometry, material);
    this.scene.add(this.pointsMesh);
    return this.pointsMesh;
  }

  /** 调整点大小 */
  setPointSize(size) {
    if (this.pointsMesh) this.pointsMesh.material.size = size;
  }

  /**
   * 用网格数据更新场景中的网格对象。
   * @param {{positions: Float32Array, indices: Uint32Array}} data
   * @param {object} options color / faceColors（逐面颜色，长度 3×面数）/ wireframe / opacity / flatShading
   */
  setMesh(data, { color = 0x86bce8, faceColors = null, wireframe = false, opacity = 1, flatShading = true } = {}) {
    this.disposeMesh();

    const geometry = new THREE.BufferGeometry();
    if (faceColors) {
      // 逐面颜色需要非索引几何（同一顶点在不同面片可有不同颜色）
      const F = data.indices.length / 3;
      const pos = new Float32Array(F * 9);
      const col = new Float32Array(F * 9);
      for (let f = 0; f < F; f++) {
        for (let k = 0; k < 3; k++) {
          const src = data.indices[f * 3 + k] * 3;
          const dst = f * 9 + k * 3;
          pos[dst] = data.positions[src];
          pos[dst + 1] = data.positions[src + 1];
          pos[dst + 2] = data.positions[src + 2];
          col[dst] = faceColors[f * 3];
          col[dst + 1] = faceColors[f * 3 + 1];
          col[dst + 2] = faceColors[f * 3 + 2];
        }
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    } else {
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    }
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({
      color: faceColors ? 0xffffff : color,
      vertexColors: Boolean(faceColors),
      roughness: 0.55,
      metalness: 0.05,
      flatShading,
      side: THREE.DoubleSide,
      transparent: opacity < 1,
      opacity,
    });

    this.meshObject = new THREE.Mesh(geometry, material);
    this.scene.add(this.meshObject);

    if (wireframe) this.setMeshWireframe(true);
    return this.meshObject;
  }

  /** 开关三角形线框（叠加显示，用于观察拓扑） */
  setMeshWireframe(visible) {
    if (!this.meshObject) return;
    if (visible && !this.wireObject) {
      const wire = new THREE.WireframeGeometry(this.meshObject.geometry);
      this.wireObject = new THREE.LineSegments(
        wire,
        new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.28, depthWrite: false }),
      );
      this.scene.add(this.wireObject);
    }
    if (visible) {
      if (this.wireObject) {
        // 线框几何需跟随网格当前几何（重建后可能被替换）
        this.wireObject.geometry.dispose();
        this.wireObject.geometry = new THREE.WireframeGeometry(this.meshObject.geometry);
      }
      this.wireObject.visible = true;
    } else if (this.wireObject) {
      this.wireObject.visible = false;
    }
  }

  setMeshVisible(visible) {
    if (this.meshObject) this.meshObject.visible = visible;
  }

  disposeMesh() {
    if (this.wireObject) {
      this.scene.remove(this.wireObject);
      this.wireObject.geometry.dispose();
      this.wireObject.material.dispose();
      this.wireObject = null;
    }
    if (!this.meshObject) return;
    this.scene.remove(this.meshObject);
    this.meshObject.geometry.dispose();
    this.meshObject.material.dispose();
    this.meshObject = null;
  }

  /** 将相机对准当前点云（等比例取景） */
  fitToPoints(padding = 1.6) {
    const sphere = this.pointsMesh?.geometry.boundingSphere;
    if (sphere) this._fitToSphere(sphere, padding);
  }

  /** 将相机对准当前网格 */
  fitToMesh(padding = 1.6) {
    const sphere = this.meshObject?.geometry.boundingSphere;
    if (sphere) this._fitToSphere(sphere, padding);
  }

  /** 将相机对准任意对象（示例自建的网格等） */
  fitToObject(object, padding = 1.6) {
    const geometry = object?.geometry;
    if (!geometry) return;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    this._fitToSphere(geometry.boundingSphere, padding);
  }

  _fitToSphere(sphere, padding) {
    const radius = Math.max(sphere.radius, 0.001);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = (radius * padding) / Math.sin(fov / 2);

    const dir = new THREE.Vector3(0.7, 0.5, 0.9).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(dir, distance);
    this.camera.near = Math.max(distance / 1000, 0.001);
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(sphere.center);
    this.controls.minDistance = radius * 0.1;
    this.controls.maxDistance = distance * 5;
    this.controls.update();

    // 让网格跟随点云尺度，避免远景下网格不可见
    this.setGridSize(radius * 2);
  }

  /** 网格随数据尺度伸缩 */
  setGridSize(size) {
    this.grid.scale.setScalar(size / 10);
    this.grid.position.y = -size / 2;
  }

  /** 是否显示辅助对象 */
  setHelpersVisible(visible) {
    this.grid.visible = visible;
    this.axes.visible = visible;
  }

  /** 向场景添加额外对象（线、标注等），随示例一起清理 */
  addObject(object) {
    this.scene.add(object);
    return object;
  }

  /** 移除并释放对象上的几何与材质 */
  removeObject(object) {
    if (!object) return;
    this.scene.remove(object);
    object.geometry?.dispose();
    object.material?.dispose();
  }

  _onResize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  disposePoints() {
    if (!this.pointsMesh) return;
    this.scene.remove(this.pointsMesh);
    this.pointsMesh.geometry.dispose();
    this.pointsMesh.material.dispose();
    this.pointsMesh = null;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.setAnimationLoop(null);
    this.disposePoints();
    this.disposeMesh();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
