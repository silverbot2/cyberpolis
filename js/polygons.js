/**
 * POLYGON ENGINE - Minimalist 3D Geometric Mesh
 * Designed for Silverbot2 // Unix
 * Ultra-smooth interactive low-poly mesh and wireframe geometry
 */

class MinimalPolygonEngine {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.mouse = {
      x: this.width / 2,
      y: this.height / 2,
      targetX: this.width / 2,
      targetY: this.height / 2,
      radius: 180
    };

    this.nodes = [];
    this.polygons = [];
    this.floatingPolyhedra = [];
    this.animId = null;
    this.time = 0;

    this.init();
  }

  init() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('mousemove', (e) => {
      this.mouse.targetX = e.clientX;
      this.mouse.targetY = e.clientY;
    });

    this.createMesh();
    this.createFloatingPolyhedra();
    this.loop();
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    this.ctx.scale(this.dpr, this.dpr);

    if (this.nodes.length > 0) {
      this.createMesh();
    }
  }

  createMesh() {
    this.nodes = [];
    // Espaciado dinámico según tamaño de pantalla
    const spacing = Math.max(90, Math.min(130, Math.floor(this.width / 12)));
    const cols = Math.ceil(this.width / spacing) + 2;
    const rows = Math.ceil(this.height / spacing) + 2;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Añadir jitter orgánico para crear polígonos asimétricos estéticos
        const jitterX = (Math.random() - 0.5) * spacing * 0.7;
        const jitterY = (Math.random() - 0.5) * spacing * 0.7;

        const x = (c - 0.5) * spacing + jitterX;
        const y = (r - 0.5) * spacing + jitterY;

        this.nodes.push({
          x: x,
          y: y,
          baseX: x,
          baseY: y,
          vx: (Math.random() - 0.5) * 0.35,
          vy: (Math.random() - 0.5) * 0.35,
          phase: Math.random() * Math.PI * 2,
          speed: 0.0008 + Math.random() * 0.0012,
          radius: 1.5 + Math.random() * 1.5
        });
      }
    }
  }

  createFloatingPolyhedra() {
    this.floatingPolyhedra = [];
    // Crear 4 poliedros geométricos flotantes 3D (Icosaedro / Octaedro wireframe)
    const count = this.width > 768 ? 4 : 2;
    for (let i = 0; i < count; i++) {
      this.floatingPolyhedra.push(this.generatePolyhedron(i, count));
    }
  }

  generatePolyhedron(index, total) {
    const size = 50 + Math.random() * 45;
    // Vértices de un octaedro regular 3D
    const vertices = [
      { x: 0, y: -size, z: 0 },
      { x: size, y: 0, z: 0 },
      { x: 0, y: 0, z: size },
      { x: -size, y: 0, z: 0 },
      { x: 0, y: 0, z: -size },
      { x: 0, y: size, z: 0 }
    ];

    // Caras triangulares (polígonos)
    const faces = [
      [0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1],
      [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4]
    ];

    return {
      cx: (this.width / (total + 1)) * (index + 1) + (Math.random() - 0.5) * 120,
      cy: 140 + Math.random() * (this.height - 300),
      rotX: Math.random() * Math.PI,
      rotY: Math.random() * Math.PI,
      rotZ: Math.random() * Math.PI,
      speedX: 0.004 + Math.random() * 0.006,
      speedY: 0.005 + Math.random() * 0.007,
      speedZ: 0.003 + Math.random() * 0.005,
      driftX: (Math.random() - 0.5) * 0.25,
      driftY: (Math.random() - 0.5) * 0.2,
      vertices,
      faces,
      scale: size
    };
  }

  update() {
    this.time += 1;
    // Suavizado del ratón
    this.mouse.x += (this.mouse.targetX - this.mouse.x) * 0.08;
    this.mouse.y += (this.mouse.targetY - this.mouse.y) * 0.08;

    // Actualizar nodos del mallado poligonal
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      // Oscilación geométrica suave
      const wave = Math.sin(this.time * node.speed + node.phase) * 14;
      const cosWave = Math.cos(this.time * node.speed * 0.8 + node.phase) * 14;

      node.x = node.baseX + wave;
      node.y = node.baseY + cosWave;

      // Interacción con ratón (repulsión elástica)
      const dx = this.mouse.x - node.x;
      const dy = this.mouse.y - node.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < this.mouse.radius) {
        const force = (1 - dist / this.mouse.radius) * 35;
        const angle = Math.atan2(dy, dx);
        node.x -= Math.cos(angle) * force;
        node.y -= Math.sin(angle) * force;
      }
    }

    // Actualizar rotación y posición de poliedros flotantes 3D
    for (let p of this.floatingPolyhedra) {
      p.rotX += p.speedX;
      p.rotY += p.speedY;
      p.rotZ += p.speedZ;
      p.cx += p.driftX;
      p.cy += p.driftY;

      // Rebote suave en bordes de pantalla
      if (p.cx < 60 || p.cx > this.width - 60) p.driftX *= -1;
      if (p.cy < 80 || p.cy > this.height - 80) p.driftY *= -1;
    }
  }

  draw() {
    this.ctx.clearRect(0, 0, this.width, this.height);

    // 1. Dibujar malla de polígonos conectados (Triangulación Delaunay aproximada por distancia)
    const maxDist = Math.max(90, Math.min(140, Math.floor(this.width / 11)));
    const maxDistSq = maxDist * maxDist;

    this.ctx.lineWidth = 0.65;

    for (let i = 0; i < this.nodes.length; i++) {
      const n1 = this.nodes[i];
      let neighbors = 0;

      for (let j = i + 1; j < this.nodes.length; j++) {
        const n2 = this.nodes[j];
        const dx = n1.x - n2.x;
        const dy = n1.y - n2.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < maxDistSq) {
          const dist = Math.sqrt(distSq);
          const alpha = (1 - dist / maxDist) * 0.16;

          // Proximidad con ratón para iluminar aristas suavemente en plateado/cian
          const midX = (n1.x + n2.x) / 2;
          const midY = (n1.y + n2.y) / 2;
          const mdx = this.mouse.x - midX;
          const mdy = this.mouse.y - midY;
          const mDist = Math.sqrt(mdx * mdx + mdy * mdy);

          if (mDist < 160) {
            const glow = (1 - mDist / 160) * 0.45;
            this.ctx.strokeStyle = `rgba(180, 210, 240, ${alpha + glow})`;
          } else {
            this.ctx.strokeStyle = `rgba(160, 175, 200, ${alpha})`;
          }

          this.ctx.beginPath();
          this.ctx.moveTo(n1.x, n1.y);
          this.ctx.lineTo(n2.x, n2.y);
          this.ctx.stroke();

          // Relleno poligonal muy sutil cuando hay un tercer nodo cercano (facetas translúcidas)
          if (neighbors < 2) {
            for (let k = j + 1; k < this.nodes.length; k++) {
              const n3 = this.nodes[k];
              const d13 = (n1.x - n3.x) ** 2 + (n1.y - n3.y) ** 2;
              const d23 = (n2.x - n3.x) ** 2 + (n2.y - n3.y) ** 2;
              if (d13 < maxDistSq && d23 < maxDistSq) {
                this.ctx.beginPath();
                this.ctx.moveTo(n1.x, n1.y);
                this.ctx.lineTo(n2.x, n2.y);
                this.ctx.lineTo(n3.x, n3.y);
                this.ctx.closePath();
                this.ctx.fillStyle = `rgba(130, 160, 200, ${alpha * 0.18})`;
                this.ctx.fill();
                neighbors++;
                break;
              }
            }
          }
        }
      }

      // Dibujar vértice / nodo
      this.ctx.beginPath();
      this.ctx.arc(n1.x, n1.y, n1.radius, 0, Math.PI * 2);
      this.ctx.fillStyle = 'rgba(210, 225, 245, 0.35)';
      this.ctx.fill();
    }

    // 2. Dibujar poliedros 3D flotantes con proyección geométrica
    this.drawFloatingPolyhedra();
  }

  drawFloatingPolyhedra() {
    for (let p of this.floatingPolyhedra) {
      const proj = [];

      // Rotación 3D
      const cosX = Math.cos(p.rotX), sinX = Math.sin(p.rotX);
      const cosY = Math.cos(p.rotY), sinY = Math.sin(p.rotY);
      const cosZ = Math.cos(p.rotZ), sinZ = Math.sin(p.rotZ);

      for (let v of p.vertices) {
        // Rotación Y
        let x1 = v.x * cosY + v.z * sinY;
        let y1 = v.y;
        let z1 = -v.x * sinY + v.z * cosY;

        // Rotación X
        let x2 = x1;
        let y2 = y1 * cosX - z1 * sinX;
        let z2 = y1 * sinX + z1 * cosX;

        // Rotación Z
        let x3 = x2 * cosZ - y2 * sinZ;
        let y3 = x2 * sinZ + y2 * cosZ;
        let z3 = z2;

        // Proyección de perspectiva 3D
        const fov = 450;
        const scale = fov / (fov + z3 + 120);
        proj.push({
          x: p.cx + x3 * scale,
          y: p.cy + y3 * scale,
          z: z3
        });
      }

      // Dibujar caras del poliedro con sombreado plano minimalista
      for (let face of p.faces) {
        const v0 = proj[face[0]];
        const v1 = proj[face[1]];
        const v2 = proj[face[2]];

        // Cálculo de normal para backface culling y sombreado
        const normalZ = (v1.x - v0.x) * (v2.y - v0.y) - (v1.y - v0.y) * (v2.x - v0.x);

        if (normalZ > 0) { // Cara frontal visible
          this.ctx.beginPath();
          this.ctx.moveTo(v0.x, v0.y);
          this.ctx.lineTo(v1.x, v1.y);
          this.ctx.lineTo(v2.x, v2.y);
          this.ctx.closePath();

          // Sombreado en escala de grises plateados
          const intensity = Math.min(1, Math.max(0.1, (v0.z + v1.z + v2.z + 100) / 200));
          this.ctx.fillStyle = `rgba(180, 205, 230, ${intensity * 0.06})`;
          this.ctx.fill();

          this.ctx.strokeStyle = `rgba(200, 220, 245, ${intensity * 0.28 + 0.08})`;
          this.ctx.lineWidth = 0.8;
          this.ctx.stroke();
        }
      }
    }
  }

  loop() {
    this.update();
    this.draw();
    this.animId = requestAnimationFrame(() => this.loop());
  }

  destroy() {
    if (this.animId) cancelAnimationFrame(this.animId);
  }
}

// Inicializar cuando el canvas esté presente
window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('polygonCanvas')) {
    window.polygonEngine = new MinimalPolygonEngine('polygonCanvas');
  }
});
