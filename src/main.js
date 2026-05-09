import * as THREE from 'three';
import './style.css';

const ARENA = { size: 52, wallHeight: 6 };
const PLAYER_HEIGHT = 1.72;
const BULLET_SPEED = 42;
const ENEMY_BULLET_SPEED = 24;
const QUALITY_PROFILES = {
  low: { label: '低画质', pixelRatio: 0.8, particles: 90, playerBullets: 36, enemyBullets: 36, pointLights: false },
  medium: { label: '均衡', pixelRatio: 1, particles: 120, playerBullets: 44, enemyBullets: 44, pointLights: true },
  high: { label: '高画质', pixelRatio: 1.25, particles: 160, playerBullets: 56, enemyBullets: 56, pointLights: true },
};
const TMP = {
  v1: new THREE.Vector3(),
  v2: new THREE.Vector3(),
  v3: new THREE.Vector3(),
  ray: new THREE.Raycaster(),
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rand = (min, max) => min + Math.random() * (max - min);
const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function makeMat(color, roughness = 0.55, metalness = 0.05, transparent = false, opacity = 1) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, transparent, opacity });
}

function createGridTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#50545a';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#747a82';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }
  ctx.strokeStyle = '#3a3d43';
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 16);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class AudioManager {
  constructor() {
    this.ctx = null;
    this.hum = null;
    this.master = null;
    this.muted = localStorage.getItem('fps-muted') === 'true';
  }

  ensure() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.42;
    this.master.connect(this.ctx.destination);
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 46;
    filter.type = 'lowpass';
    filter.frequency.value = 82;
    gain.gain.value = 0.004;
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start();
    this.hum = { osc, gain };
  }

  setMuted(value) {
    this.muted = value;
    localStorage.setItem('fps-muted', `${value}`);
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(value ? 0 : 0.42, this.ctx.currentTime, 0.04);
  }

  beep(type) {
    if (this.muted) return;
    this.ensure();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const presets = {
      shoot: ['triangle', 118, 0.045, 0.052, 680],
      reload: ['sine', 220, 0.16, 0.035, 520],
      hit: ['triangle', 126, 0.08, 0.045, 620],
      pickup: ['sine', 620, 0.14, 0.048, 1500],
      hurt: ['sine', 82, 0.16, 0.055, 360],
    };
    const [wave, freq, dur, volume, cutoff] = presets[type] || presets.pickup;
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.45), now + dur);
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }
}

class Bullet {
  constructor(scene, color = 0xfff2a0) {
    this.scene = scene;
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 8, 8),
      new THREE.MeshBasicMaterial({ color }),
    );
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.active = false;
    this.owner = 'player';
    this.velocity = new THREE.Vector3();
    this.life = 0;
    scene.add(this.group);
    this.group.visible = false;
  }

  fire(origin, direction, speed, owner) {
    this.active = true;
    this.owner = owner;
    this.life = 1.8;
    this.group.visible = true;
    this.group.position.copy(origin);
    this.velocity.copy(direction).normalize().multiplyScalar(speed);
  }

  update(dt, game) {
    if (!this.active) return;
    this.life -= dt;
    this.group.position.addScaledVector(this.velocity, dt);
    if (Math.abs(this.group.position.x) > ARENA.size / 2 || Math.abs(this.group.position.z) > ARENA.size / 2 || this.life <= 0) {
      this.release();
      return;
    }
    for (const wall of game.coverWalls) {
      if (wall.box.containsPoint(this.group.position)) {
        game.particles.burst(this.group.position, 0xdddddd, 8, 1.7);
        this.release();
        return;
      }
    }
    if (this.owner === 'player') {
      for (const enemy of game.enemies) {
        if (!enemy.alive) continue;
        const hitRadius = enemy.type === 'boss' ? 1.2 : 0.78;
        const head = enemy.headWorldPosition();
        const body = enemy.group.position;
        if (this.group.position.distanceTo(head) < hitRadius || this.group.position.distanceTo(body) < hitRadius) {
          enemy.takeDamage(this.group.position.distanceTo(head) < hitRadius ? 45 : 26, game);
          this.release();
          return;
        }
      }
    } else if (!game.player.invulnerable && this.group.position.distanceTo(game.player.camera.position) < 0.75) {
      game.player.takeDamage(10, game);
      this.release();
    }
  }

  release() {
    this.active = false;
    this.group.visible = false;
  }
}

class BulletPool {
  constructor(scene, count, color) {
    this.pool = Array.from({ length: count }, () => new Bullet(scene, color));
  }

  fire(origin, direction, speed, owner) {
    const bullet = this.pool.find((item) => !item.active);
    if (bullet) bullet.fire(origin, direction, speed, owner);
  }

  update(dt, game) {
    this.pool.forEach((bullet) => bullet.update(dt, game));
  }

  reset() {
    this.pool.forEach((bullet) => bullet.release());
  }
}

class ParticlePool {
  constructor(scene, count = 180) {
    this.scene = scene;
    this.pool = Array.from({ length: count }, () => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.13, 0.13, 0.13),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 }),
      );
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, active: false, velocity: new THREE.Vector3(), life: 0, maxLife: 1 };
    });
  }

  burst(position, color, count = 14, power = 3) {
    for (let i = 0; i < count; i += 1) {
      const p = this.pool.find((item) => !item.active);
      if (!p) return;
      p.active = true;
      p.life = rand(0.35, 0.9);
      p.maxLife = p.life;
      p.mesh.visible = true;
      p.mesh.position.copy(position);
      p.mesh.material.color.setHex(color);
      p.mesh.material.opacity = 1;
      p.velocity.set(rand(-1, 1), rand(0.25, 1.4), rand(-1, 1)).normalize().multiplyScalar(rand(power * 0.35, power));
    }
  }

  update(dt) {
    this.pool.forEach((p) => {
      if (!p.active) return;
      p.life -= dt;
      p.velocity.y -= 5.8 * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.mesh.rotation.x += dt * 7;
      p.mesh.rotation.y += dt * 5;
      p.mesh.material.opacity = clamp(p.life / p.maxLife, 0, 1);
      if (p.life <= 0) {
        p.active = false;
        p.mesh.visible = false;
      }
    });
  }
}

class Player {
  constructor(camera, hud) {
    this.camera = camera;
    this.hud = hud;
    this.health = 100;
    this.ammo = 30;
    this.reserve = 30;
    this.score = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.velocity = new THREE.Vector3();
    this.keys = new Set();
    this.fireHeld = false;
    this.fireCooldown = 0;
    this.reloadTimer = 0;
    this.recoil = 0;
    this.shake = 0;
    this.invulnerableTimer = 0;
    this.hudCache = {};
    this.camera.position.set(0, PLAYER_HEIGHT, 18);
    this.weapon = this.createWeapon();
    camera.add(this.weapon);
    this.updateHud();
  }

  get invulnerable() {
    return this.invulnerableTimer > 0;
  }

  createWeapon() {
    const group = new THREE.Group();
    const metal = makeMat(0x242931, 0.32, 0.8);
    const black = makeMat(0x11151a, 0.45, 0.7);
    const skin = makeMat(0xc58b61, 0.7, 0.02);
    const addBox = (size, pos, mat) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
      mesh.position.set(...pos);
      group.add(mesh);
      return mesh;
    };
    addBox([0.38, 0.34, 1.18], [0.48, -0.42, -0.9], metal);
    addBox([0.18, 0.18, 1.15], [0.5, -0.36, -1.55], black);
    addBox([0.28, 0.48, 0.24], [0.48, -0.76, -0.62], black);
    addBox([0.26, 0.22, 0.72], [0.22, -0.61, -0.35], metal);
    addBox([0.16, 0.62, 0.18], [0.47, -0.84, -0.98], black);
    addBox([0.55, 0.14, 0.28], [0.48, -0.22, -0.46], metal);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.72, 16), black);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0.49, -0.36, -1.98);
    group.add(barrel);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.9, 12), skin);
    arm.rotation.z = Math.PI / 2.7;
    arm.rotation.x = Math.PI / 8;
    arm.position.set(0.04, -0.72, -0.46);
    group.add(arm);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.24, 0.22), skin);
    hand.position.set(0.36, -0.68, -0.73);
    group.add(hand);
    const flash = new THREE.PointLight(0xffb02e, 0, 4);
    flash.position.set(0.49, -0.36, -2.36);
    group.add(flash);
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.48, 14),
      new THREE.MeshBasicMaterial({ color: 0xffbc45, transparent: true, opacity: 0 }),
    );
    cone.rotation.x = -Math.PI / 2;
    cone.position.set(0.49, -0.36, -2.34);
    group.add(cone);
    group.userData.flash = flash;
    group.userData.cone = cone;
    group.position.set(0.32, -0.22, -0.42);
    group.traverse((obj) => {
      obj.renderOrder = 20;
      if (obj.material) {
        obj.material.depthTest = false;
        obj.material.depthWrite = false;
      }
    });
    return group;
  }

  update(dt, game) {
    if (this.invulnerableTimer > 0) this.invulnerableTimer -= dt;
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        const needed = 30 - this.ammo;
        const load = Math.min(needed, this.reserve);
        this.ammo += load;
        this.reserve -= load;
        this.updateHud();
      }
    }
    this.fireCooldown -= dt;
    if (this.fireHeld) this.shoot(game);

    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw) * -1);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (this.keys.has('KeyW')) wish.add(forward);
    if (this.keys.has('KeyS')) wish.sub(forward);
    if (this.keys.has('KeyD')) wish.add(right);
    if (this.keys.has('KeyA')) wish.sub(right);
    if (game.touch.move.lengthSq() > 0.01) {
      wish.addScaledVector(forward, -game.touch.move.y);
      wish.addScaledVector(right, game.touch.move.x);
    }
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(8.2);
    this.velocity.lerp(wish, 1 - Math.pow(0.001, dt));
    const next = this.camera.position.clone().addScaledVector(this.velocity, dt);
    next.x = clamp(next.x, -ARENA.size / 2 + 1, ARENA.size / 2 - 1);
    next.z = clamp(next.z, -ARENA.size / 2 + 1, ARENA.size / 2 - 1);
    if (!game.collidesWithCover(next, 0.65)) this.camera.position.copy(next);
    this.camera.position.y = PLAYER_HEIGHT + Math.sin(performance.now() * 0.008) * this.velocity.length() * 0.006;

    this.shake = Math.max(0, this.shake - dt * 4);
    this.recoil = Math.max(0, this.recoil - dt * 7.5);
    this.camera.rotation.set(this.pitch - this.recoil * 0.04 + rand(-this.shake, this.shake) * 0.015, this.yaw + rand(-this.shake, this.shake) * 0.012, 0, 'YXZ');
    this.weapon.rotation.x = -this.recoil * 0.24;
    this.weapon.position.z = -0.42 + this.recoil * 0.11;
    this.weapon.userData.flash.intensity = Math.max(0, this.weapon.userData.flash.intensity - dt * 38);
    this.weapon.userData.cone.material.opacity = Math.max(0, this.weapon.userData.cone.material.opacity - dt * 14);
  }

  look(dx, dy) {
    this.yaw -= dx * 0.0023;
    this.pitch = clamp(this.pitch - dy * 0.002, -1.25, 1.25);
  }

  shoot(game) {
    if (this.fireCooldown > 0 || this.reloadTimer > 0 || game.over) return;
    if (this.ammo <= 0) {
      game.audio.beep('reload');
      this.reload();
      return;
    }
    this.fireCooldown = 0.085;
    this.ammo -= 1;
    this.recoil = 1;
    this.weapon.userData.flash.intensity = 8;
    this.weapon.userData.cone.material.opacity = 0.86;
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    const origin = this.camera.position.clone().addScaledVector(dir, 1.2);
    game.playerBullets.fire(origin, dir, BULLET_SPEED, 'player');
    game.particles.burst(origin, 0xffaa2a, 6, 2.2);
    game.audio.beep('shoot');
    this.updateHud();
  }

  reload() {
    if (this.reloadTimer > 0 || this.ammo === 30 || this.reserve <= 0) return;
    this.reloadTimer = 0.9;
  }

  takeDamage(amount, game) {
    this.health = Math.max(0, this.health - amount);
    this.shake = 1;
    this.hud.damage.classList.remove('active');
    void this.hud.damage.offsetWidth;
    this.hud.damage.classList.add('active');
    game.audio.beep('hurt');
    this.updateHud();
    if (this.health <= 0) game.endGame();
  }

  updateHud() {
    const next = {
      health: Math.round(this.health),
      ammo: `${this.ammo}/30`,
      reserve: `${this.reserve}`,
      score: `${this.score}`,
      shield: this.invulnerable,
    };
    if (this.hudCache.health !== next.health) {
      this.hud.healthBar.style.width = `${next.health}%`;
      this.hud.healthText.textContent = `${next.health}`;
    }
    if (this.hudCache.ammo !== next.ammo) this.hud.ammo.textContent = next.ammo;
    if (this.hudCache.reserve !== next.reserve) this.hud.reserve.textContent = next.reserve;
    if (this.hudCache.score !== next.score) this.hud.score.textContent = next.score;
    if (this.hudCache.shield !== next.shield) this.hud.shield.hidden = !next.shield;
    this.hudCache = next;
  }
}

class Enemy {
  constructor(type, position) {
    this.type = type;
    this.alive = true;
    this.speed = type === 'fast' ? 4.8 : type === 'boss' ? 2.4 : 3.1;
    this.maxHealth = type === 'fast' ? 55 : type === 'boss' ? 260 : 95;
    this.health = this.maxHealth;
    this.fireTimer = rand(0.2, 1.2);
    this.target = position.clone();
    this.group = this.createModel();
    this.group.position.copy(position);
  }

  createModel() {
    const scale = this.type === 'boss' ? 1.38 : 1;
    const color = this.type === 'fast' ? 0x8d4bff : this.type === 'boss' ? 0xffc83d : 0xd94444;
    const dark = makeMat(0x1f242b, 0.48, 0.3);
    const bodyMat = makeMat(color, 0.42, this.type === 'boss' ? 0.45 : 0.12);
    const headMat = makeMat(0xf0d3a8, 0.65, 0.02);
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.75 * scale, 1.1 * scale, 0.36 * scale), bodyMat);
    body.position.y = 1.2 * scale;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.45 * scale, 0.45 * scale, 0.45 * scale), headMat);
    head.position.y = 2.05 * scale;
    const armGeo = new THREE.BoxGeometry(0.22 * scale, 0.78 * scale, 0.22 * scale);
    const legGeo = new THREE.BoxGeometry(0.25 * scale, 0.82 * scale, 0.25 * scale);
    const leftArm = new THREE.Mesh(armGeo, bodyMat);
    const rightArm = new THREE.Mesh(armGeo, bodyMat);
    leftArm.position.set(-0.55 * scale, 1.2 * scale, 0);
    rightArm.position.set(0.55 * scale, 1.2 * scale, 0);
    const leftLeg = new THREE.Mesh(legGeo, dark);
    const rightLeg = new THREE.Mesh(legGeo, dark);
    leftLeg.position.set(-0.23 * scale, 0.42 * scale, 0);
    rightLeg.position.set(0.23 * scale, 0.42 * scale, 0);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.18 * scale, 0.16 * scale, 0.95 * scale), dark);
    gun.position.set(0.42 * scale, 1.34 * scale, -0.55 * scale);
    const flash = new THREE.PointLight(0xffb12f, 0, 5);
    flash.position.set(0.42 * scale, 1.34 * scale, -1.1 * scale);
    g.add(body, head, leftArm, rightArm, leftLeg, rightLeg, gun, flash);
    g.userData.flash = flash;
    return g;
  }

  headWorldPosition() {
    return this.group.localToWorld(new THREE.Vector3(0, this.type === 'boss' ? 2.82 : 2.05, 0));
  }

  update(dt, game) {
    if (!this.alive) return;
    const playerPos = game.player.camera.position;
    const toPlayer = TMP.v1.copy(playerPos).sub(this.group.position);
    toPlayer.y = 0;
    const distance = toPlayer.length();
    if (distance > 7) {
      toPlayer.normalize();
      const coverBias = game.nearestCoverPoint(this.group.position);
      if (coverBias && Math.random() < 0.35) toPlayer.lerp(TMP.v2.copy(coverBias).sub(this.group.position).normalize(), 0.35);
      const next = this.group.position.clone().addScaledVector(toPlayer, this.speed * dt);
      if (!game.collidesWithCover(next, 0.55)) this.group.position.copy(next);
    }
    this.group.lookAt(playerPos.x, this.group.position.y, playerPos.z);
    this.group.userData.flash.intensity = Math.max(0, this.group.userData.flash.intensity - dt * 28);
    this.fireTimer -= dt;
    if (this.fireTimer <= 0 && distance < 28 && game.hasLineOfSight(this.group.position, playerPos)) {
      this.fireTimer = this.type === 'boss' ? 0.55 : this.type === 'fast' ? 0.74 : 0.95;
      const origin = this.headWorldPosition().add(new THREE.Vector3(0, -0.45, 0));
      const dir = playerPos.clone().sub(origin).normalize();
      game.enemyBullets.fire(origin, dir, ENEMY_BULLET_SPEED, 'enemy');
      game.particles.burst(origin, 0xff7a22, 5, 1.8);
      this.group.userData.flash.intensity = 7;
    }
  }

  takeDamage(amount, game) {
    this.health -= amount;
    game.audio.beep('hit');
    game.particles.burst(this.headWorldPosition(), 0xffffff, 8, 2);
    if (this.health <= 0) {
      this.alive = false;
      this.group.visible = false;
      game.particles.burst(this.group.position.clone().add(new THREE.Vector3(0, 1.2, 0)), this.type === 'boss' ? 0xffc83d : this.type === 'fast' ? 0x8d4bff : 0xd94444, 26, 5);
      game.player.score += this.type === 'boss' ? 500 : this.type === 'fast' ? 160 : 100;
      game.player.updateHud();
      window.setTimeout(() => game.respawnEnemy(this.type === 'boss' ? 'normal' : null), 900);
    }
  }
}

class Pickup {
  constructor(type, position) {
    this.type = type;
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.createMesh();
  }

  createMesh() {
    if (this.type === 'health') {
      const mat = new THREE.MeshStandardMaterial({ color: 0xff3144, emissive: 0x3b0006, roughness: 0.4 });
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.9, 0.28), mat);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.34, 0.28), mat);
      this.group.add(a, b);
    } else if (this.type === 'ammo') {
      const mat = makeMat(0xffc928, 0.45, 0.3);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.52, 0.62), mat);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.12, 0.66), makeMat(0x2a2614, 0.5, 0.2));
      this.group.add(box, stripe);
    } else {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.48, 24, 16),
        new THREE.MeshStandardMaterial({ color: 0x3aa6ff, emissive: 0x07345f, transparent: true, opacity: 0.58, roughness: 0.18 }),
      );
      this.group.add(sphere);
    }
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.72, 16, 10),
      new THREE.MeshBasicMaterial({
        color: this.type === 'shield' ? 0x3aa6ff : this.type === 'ammo' ? 0xffd447 : 0xff4658,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      }),
    );
    this.group.add(glow);
  }

  update(dt, game) {
    this.group.rotation.y += dt * 1.8;
    this.group.position.y = 0.95 + Math.sin(performance.now() * 0.003 + this.group.position.x) * 0.18;
    if (dist2D(this.group.position, game.player.camera.position) < 1.15) this.apply(game);
  }

  apply(game) {
    const player = game.player;
    if (this.type === 'health') player.health = Math.min(100, player.health + 30);
    if (this.type === 'ammo') player.reserve = Math.min(120, player.reserve + 30);
    if (this.type === 'shield') player.invulnerableTimer = 5;
    game.audio.beep('pickup');
    game.particles.burst(this.group.position, this.type === 'shield' ? 0x3aa6ff : this.type === 'ammo' ? 0xffd447 : 0xff4658, 18, 3.8);
    player.updateHud();
    game.scene.remove(this.group);
    game.pickups = game.pickups.filter((pickup) => pickup !== this);
    window.setTimeout(() => game.spawnPickup(), 5000);
  }
}

class Game {
  constructor() {
    this.app = document.querySelector('#app');
    this.hud = {
      healthBar: document.querySelector('#healthBar'),
      healthText: document.querySelector('#healthText'),
      ammo: document.querySelector('#ammo'),
      reserve: document.querySelector('#reserve'),
      score: document.querySelector('#score'),
      shield: document.querySelector('#shieldState'),
      damage: document.querySelector('#damageFlash'),
      gameOver: document.querySelector('#gameOver'),
      finalScore: document.querySelector('#finalScore'),
      start: document.querySelector('#startOverlay'),
      lock: document.querySelector('#lockState'),
      quality: document.querySelector('#qualitySelect'),
      fps: document.querySelector('#fpsMeter'),
      sound: document.querySelector('#soundToggle'),
    };
    this.touch = {
      move: new THREE.Vector2(),
      joystickId: null,
      lookId: null,
      stickCenter: new THREE.Vector2(),
    };
    this.audio = new AudioManager();
    this.lastFrame = performance.now();
    this.quality = localStorage.getItem('fps-quality') || 'medium';
    this.fpsAverage = 60;
    this.fpsTimer = 0;
    this.lowFpsSeconds = 0;
    this.over = false;
    this.initRenderer();
    this.bindEvents();
    this.updateSoundButton();
    this.reset();
    this.animate();
  }

  initRenderer() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x151920);
    this.scene.fog = new THREE.Fog(0x151920, 28, 72);
    this.camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.1, 120);
    this.scene.add(this.camera);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = false;
    this.app.appendChild(this.renderer.domElement);
  }

  reset() {
    this.scene.children.filter((child) => child !== this.camera).forEach((child) => this.scene.remove(child));
    while (this.camera.children.length) this.camera.remove(this.camera.children[0]);
    this.coverWalls = [];
    this.enemies = [];
    this.pickups = [];
    this.over = false;
    this.hud.gameOver.hidden = true;
    const profile = QUALITY_PROFILES[this.quality];
    this.playerBullets = new BulletPool(this.scene, profile.playerBullets, 0xfff2a0);
    this.enemyBullets = new BulletPool(this.scene, profile.enemyBullets, 0xff7a22);
    this.particles = new ParticlePool(this.scene, profile.particles);
    this.buildArena();
    this.player = new Player(this.camera, this.hud);
    this.spawnCovers();
    ['normal', 'normal', 'normal', 'normal', 'fast', 'fast', 'boss'].forEach((type) => this.respawnEnemy(type));
    for (let i = 0; i < 6; i += 1) this.spawnPickup();
    this.hud.quality.value = this.quality;
    this.applyQuality(false);
  }

  pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, QUALITY_PROFILES[this.quality].pixelRatio);
  }

  applyQuality(shouldReset = true) {
    localStorage.setItem('fps-quality', this.quality);
    this.renderer.setPixelRatio(this.pixelRatio());
    this.scene.traverse((obj) => {
      if (obj.isPointLight) obj.visible = QUALITY_PROFILES[this.quality].pointLights;
    });
    if (shouldReset) this.reset();
  }

  lowerQualityIfNeeded() {
    const order = ['high', 'medium', 'low'];
    const index = order.indexOf(this.quality);
    if (index < order.length - 1) {
      this.quality = order[index + 1];
      this.hud.quality.value = this.quality;
      this.applyQuality(true);
    }
  }

  buildArena() {
    const ambient = new THREE.HemisphereLight(0xbfd7ff, 0x2b2520, 1.15);
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.position.set(-12, 20, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const pointA = new THREE.PointLight(0x50a8ff, 2.4, 24);
    pointA.position.set(-18, 4, -18);
    const pointB = new THREE.PointLight(0xffb65a, 2.1, 22);
    pointB.position.set(18, 4, 16);
    this.scene.add(ambient, sun, pointA, pointB);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA.size, ARENA.size),
      new THREE.MeshStandardMaterial({ map: createGridTexture(), roughness: 0.82, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const wallMat = makeMat(0x343a42, 0.68, 0.08);
    const wallDefs = [
      [[ARENA.size, ARENA.wallHeight, 0.7], [0, ARENA.wallHeight / 2, -ARENA.size / 2]],
      [[ARENA.size, ARENA.wallHeight, 0.7], [0, ARENA.wallHeight / 2, ARENA.size / 2]],
      [[0.7, ARENA.wallHeight, ARENA.size], [-ARENA.size / 2, ARENA.wallHeight / 2, 0]],
      [[0.7, ARENA.wallHeight, ARENA.size], [ARENA.size / 2, ARENA.wallHeight / 2, 0]],
    ];
    wallDefs.forEach(([size, pos]) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(...size), wallMat);
      wall.position.set(...pos);
      wall.receiveShadow = true;
      wall.castShadow = true;
      this.scene.add(wall);
    });
  }

  spawnCovers() {
    const mats = [makeMat(0x7a7d7c, 0.86, 0.05), makeMat(0x38404a, 0.52, 0.55), makeMat(0x5d655f, 0.75, 0.1), makeMat(0x806f5b, 0.7, 0.15)];
    const spots = [
      [-14, -10, 5, 2.2, 1.4, 0.2], [10, -12, 3.5, 4.2, 1.4, -0.4], [-6, 4, 8, 1.4, 2.8, 0.5],
      [13, 5, 6, 1.2, 4.5, -0.2], [-17, 10, 3.2, 5.4, 1.6, 0.1], [2, -3, 4.8, 2.1, 3.2, 0.8],
      [19, -1, 2.8, 4.6, 1.3, 0.3], [-12, 17, 5.8, 1.3, 2.4, -0.7],
    ];
    spots.forEach((s, i) => {
      const [x, z, w, d, h, rot] = s;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats[i % mats.length]);
      wall.position.set(x, h / 2, z);
      wall.rotation.y = rot;
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.scene.add(wall);
      wall.updateMatrixWorld();
      const box = new THREE.Box3().setFromObject(wall);
      this.coverWalls.push({ mesh: wall, box });
    });
  }

  randomFreePosition() {
    for (let i = 0; i < 80; i += 1) {
      const pos = new THREE.Vector3(rand(-22, 22), 0, rand(-22, 22));
      if (dist2D(pos, this.camera.position) > 8 && !this.collidesWithCover(pos, 1.2)) return pos;
    }
    return new THREE.Vector3(rand(-18, 18), 0, rand(-18, 18));
  }

  respawnEnemy(forcedType = null) {
    if (this.over) return;
    const type = forcedType || (Math.random() < 0.22 ? 'fast' : 'normal');
    const enemy = new Enemy(type, this.randomFreePosition());
    this.enemies.push(enemy);
    this.scene.add(enemy.group);
    this.enemies = this.enemies.filter((item) => item.alive || item.group.visible);
  }

  spawnPickup() {
    if (this.over) return;
    const type = ['health', 'ammo', 'shield'][Math.floor(Math.random() * 3)];
    const pickup = new Pickup(type, this.randomFreePosition().setY(0.95));
    this.pickups.push(pickup);
    this.scene.add(pickup.group);
  }

  collidesWithCover(pos, radius) {
    return this.coverWalls.some(({ box }) => {
      TMP.v3.set(pos.x, 1, pos.z);
      box.clampPoint(TMP.v3, TMP.v2);
      return TMP.v2.distanceToSquared(TMP.v3) <= radius * radius;
    });
  }

  nearestCoverPoint(pos) {
    let best = null;
    let bestD = Infinity;
    this.coverWalls.forEach(({ mesh }) => {
      const d = dist2D(mesh.position, pos);
      if (d < bestD) {
        best = mesh.position;
        bestD = d;
      }
    });
    return best;
  }

  hasLineOfSight(from, to) {
    const origin = from.clone().add(new THREE.Vector3(0, 1.2, 0));
    const target = to.clone();
    const dir = target.sub(origin);
    const distance = dir.length();
    TMP.ray.set(origin, dir.normalize());
    const hits = TMP.ray.intersectObjects(this.coverWalls.map((wall) => wall.mesh), false);
    return hits.length === 0 || hits[0].distance > distance;
  }

  bindEvents() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(this.pixelRatio());
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
    window.addEventListener('keydown', (e) => {
      this.player?.keys.add(e.code);
      if (e.code === 'KeyR') {
        this.player.reload();
        this.audio.beep('reload');
      }
    });
    window.addEventListener('keyup', (e) => this.player?.keys.delete(e.code));
    this.renderer.domElement.addEventListener('click', () => {
      this.audio.ensure();
      this.renderer.domElement.requestPointerLock?.();
      this.hud.start.hidden = true;
    });
    document.addEventListener('pointerlockchange', () => {
      this.hud.lock.textContent = document.pointerLockElement ? '鼠标已锁定' : '点击画面锁定鼠标';
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.renderer.domElement) this.player.look(e.movementX, e.movementY);
    });
    window.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.audio.ensure();
        this.player.fireHeld = true;
        this.player.shoot(this);
      }
    });
    window.addEventListener('mouseup', () => { if (this.player) this.player.fireHeld = false; });
    document.querySelector('#restartBtn').addEventListener('click', () => this.reset());
    document.querySelector('#startBtn').addEventListener('click', () => {
      this.audio.ensure();
      this.renderer.domElement.requestPointerLock?.();
      this.hud.start.hidden = true;
    });
    this.hud.sound.addEventListener('click', (event) => {
      event.stopPropagation();
      this.audio.ensure();
      this.audio.setMuted(!this.audio.muted);
      this.updateSoundButton();
    });
    this.hud.quality.addEventListener('change', (event) => {
      this.quality = event.target.value;
      this.applyQuality(true);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.player) this.player.fireHeld = false;
    });
    this.bindTouch();
  }

  updateSoundButton() {
    this.hud.sound.textContent = this.audio.muted ? '音效关' : '音效开';
    this.hud.sound.setAttribute('aria-pressed', `${!this.audio.muted}`);
  }

  bindTouch() {
    const joystick = document.querySelector('#joystick');
    const knob = document.querySelector('#joystickKnob');
    const fire = document.querySelector('#fireButton');
    joystick.addEventListener('pointerdown', (e) => {
      this.touch.joystickId = e.pointerId;
      joystick.setPointerCapture(e.pointerId);
      const rect = joystick.getBoundingClientRect();
      this.touch.stickCenter.set(rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    joystick.addEventListener('pointermove', (e) => {
      if (this.touch.joystickId !== e.pointerId) return;
      const dx = e.clientX - this.touch.stickCenter.x;
      const dy = e.clientY - this.touch.stickCenter.y;
      const len = Math.min(46, Math.hypot(dx, dy));
      const angle = Math.atan2(dy, dx);
      const x = Math.cos(angle) * len;
      const y = Math.sin(angle) * len;
      knob.style.transform = `translate(${x}px, ${y}px)`;
      this.touch.move.set(x / 46, y / 46);
    });
    const endStick = () => {
      this.touch.joystickId = null;
      this.touch.move.set(0, 0);
      knob.style.transform = 'translate(0, 0)';
    };
    joystick.addEventListener('pointerup', endStick);
    joystick.addEventListener('pointercancel', endStick);
    fire.addEventListener('pointerdown', (e) => {
      fire.setPointerCapture(e.pointerId);
      this.audio.ensure();
      this.player.fireHeld = true;
      this.autoAim();
      this.player.shoot(this);
    });
    fire.addEventListener('pointerup', () => { this.player.fireHeld = false; });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || e.target.closest('#joystick, #fireButton')) return;
      this.player.look(e.movementX || 0, e.movementY || 0);
    });
  }

  autoAim() {
    const living = this.enemies.filter((enemy) => enemy.alive);
    living.sort((a, b) => this.camera.position.distanceTo(a.group.position) - this.camera.position.distanceTo(b.group.position));
    const target = living[0]?.headWorldPosition();
    if (!target) return;
    const dir = target.sub(this.camera.position).normalize();
    this.player.yaw = Math.atan2(dir.x, -dir.z);
    this.player.pitch = Math.asin(clamp(dir.y, -1, 1));
  }

  endGame() {
    this.over = true;
    this.hud.finalScore.textContent = this.player.score;
    this.hud.gameOver.hidden = false;
    document.exitPointerLock?.();
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const now = performance.now();
    const dt = Math.min(0.033, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const fps = dt > 0 ? 1 / dt : 60;
    this.fpsAverage = this.fpsAverage * 0.94 + fps * 0.06;
    this.fpsTimer += dt;
    this.lowFpsSeconds = this.fpsAverage < 42 ? this.lowFpsSeconds + dt : 0;
    if (this.lowFpsSeconds > 4) {
      this.lowFpsSeconds = 0;
      this.lowerQualityIfNeeded();
    }
    if (this.fpsTimer > 0.45) {
      this.fpsTimer = 0;
      this.hud.fps.textContent = `${Math.round(this.fpsAverage)} FPS`;
    }
    if (!this.over) {
      this.player.update(dt, this);
      this.enemies.forEach((enemy) => enemy.update(dt, this));
      this.pickups.slice().forEach((pickup) => pickup.update(dt, this));
      this.playerBullets.update(dt, this);
      this.enemyBullets.update(dt, this);
      this.particles.update(dt);
      this.player.updateHud();
    }
    this.renderer.render(this.scene, this.camera);
  }
}

document.querySelector('#app').innerHTML = `
  <div id="hud">
    <div class="hud-panel health-panel">
      <div class="hud-label">生命值 <span id="healthText">100</span></div>
      <div class="health-track"><div id="healthBar"></div></div>
      <div id="shieldState" hidden>护盾激活</div>
    </div>
    <div class="hud-panel ammo-panel">
      <div>弹药 <strong id="ammo">30/30</strong></div>
      <div>备用 <span id="reserve">30</span></div>
      <div>得分 <strong id="score">0</strong></div>
    </div>
  </div>
  <div id="crosshair" aria-hidden="true"></div>
  <div id="damageFlash"></div>
  <div id="lockState">点击画面锁定鼠标</div>
  <div id="systemPanel">
    <label for="qualitySelect">画质</label>
    <select id="qualitySelect" aria-label="画质">
      <option value="low">低画质</option>
      <option value="medium">均衡</option>
      <option value="high">高画质</option>
    </select>
    <span id="fpsMeter">60 FPS</span>
    <button id="soundToggle" type="button" aria-pressed="true">音效开</button>
  </div>
  <div id="startOverlay" class="overlay">
    <div class="modal">
      <h1>仓库突击训练</h1>
      <p>WASD 移动，鼠标瞄准，左键自动射击，R 换弹。移动端可用摇杆、射击按钮和辅助瞄准。</p>
      <button id="startBtn" type="button">开始训练</button>
    </div>
  </div>
  <div id="gameOver" class="overlay" hidden>
    <div class="modal">
      <h2>游戏结束</h2>
      <p>最终得分：<strong id="finalScore">0</strong></p>
      <button id="restartBtn" type="button">重新开始</button>
    </div>
  </div>
  <div id="mobileControls">
    <div id="joystick"><div id="joystickKnob"></div></div>
    <button id="fireButton" type="button">开火</button>
  </div>
`;

new Game();
