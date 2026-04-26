import * as THREE from 'three';

// ─── Tuning Constants ───────────────────────────────────────────────────────
const TUNING = {
  SPRING_SCALE: 2.0,           // repulsion → spring 的缩放因子
  REF_MAX_SPRING: 100.0,       // 角弹簧归一化参考最大值
  MODE2_SPRING_BOOST: 1.5,     // Mode 2 的 spring 增强倍数
  DEFAULT_PULL: 0.5,           // 缺省阻尼
  DEFAULT_SPRING: 0.3,         // 缺省弹性
  DEFAULT_STIFFNESS: 0.1,      // 缺省刚性
  MAX_DELTA: 0.1,              // 最大 delta 时间（秒）
  GRAVITY: [0, -9.8 * 10, 0], // 默认重力（与 Bullet 方案一致）
  LENGTH_TOLERANCE: 0.001,     // 长度约束容差
};

// ─── Pre-allocated temp objects for per-frame reuse (zero-allocation) ────────
const _tempVec3 = new THREE.Vector3();
const _tempQuat = new THREE.Quaternion();
const _restDir  = new THREE.Vector3();
const _curDir   = new THREE.Vector3();

// ─── ChainData Factory ──────────────────────────────────────────────────────
/**
 * Create a ChainData object with pre-allocated typed arrays for N particles.
 * All working memory is allocated up-front so the per-frame simulation loop
 * never creates new objects (Requirement 6.2).
 *
 * @param {number} particleCount - Number of particles in the chain (including root)
 * @returns {object} ChainData
 */
function createChainData(particleCount) {
  const N = particleCount;
  return {
    // ── Particle positions (Float64Array, 3 components per particle) ──
    positions:     new Float64Array(N * 3),  // current world positions
    prevPositions: new Float64Array(N * 3),  // previous frame positions
    restPositions: new Float64Array(N * 3),  // initial rest pose positions (world)

    // ── Bone associations ──
    boneIndices:   new Int32Array(N),        // skeleton bone index per particle
    parentIndices: new Int32Array(N),        // parent particle index (-1 for root)

    // ── Constraint parameters ──
    boneLengths:   new Float64Array(N),      // rest distance to parent (0 for root)

    // ── Per-particle dynamics parameters (mapped from PMX) ──
    pull:      new Float64Array(N),          // damping [0,1]
    spring:    new Float64Array(N),          // elasticity [0,1]
    stiffness: new Float64Array(N),          // angular stiffness [0,1]

    // ── Rest pose local directions (for stiffness & elasticity) ──
    restLocalDirections: new Float64Array(N * 3),

    // ── Collision filtering ──
    collisionGroup: 0,
    collisionMask:  0,

    // ── Metadata ──
    particleCount: N,
    rootBoneIndex: -1,
  };
}

// ─── ColliderData Factory ───────────────────────────────────────────────────
/**
 * Create a ColliderData object with pre-allocated typed arrays.
 *
 * @param {'sphere'|'capsule'} type - Collider geometry type
 * @returns {object} ColliderData
 */
function createColliderData(type) {
  return {
    type: type,

    // ── Sphere / capsule shared ──
    radius: 0,

    // ── World-space coordinates (updated each frame from bone) ──
    worldCenter:  new Float64Array(3),       // sphere center / capsule endpoint A
    worldTailPos: new Float64Array(3),       // capsule endpoint B (unused for sphere)
    halfLength: 0,                           // capsule half-length (0 for sphere)

    // ── Local-space coordinates (relative to bone, computed at init) ──
    localCenter:  new Float64Array(3),
    localTailPos: new Float64Array(3),

    // ── Bone association ──
    boneIndex: -1,

    // ── Collision filtering ──
    collisionGroup: 0,
    collisionMask:  0,
  };
}

// ─── ChainSimulator ─────────────────────────────────────────────────────────
/**
 * Core simulation logic for a single particle chain.
 * All methods are static and operate directly on typed arrays with index
 * offsets — zero per-frame allocations (Requirement 6.2).
 */
class ChainSimulator {

  /**
   * Verlet integration step for every non-root particle in the chain.
   *
   * For each particle i (i >= 1):
   *   velocity = pos[i] - prevPos[i]
   *   prevPos[i] = pos[i]
   *   pos[i] += velocity * (1 - pull[i]) + gravity * delta²
   *
   * @param {object}       chain   - ChainData object
   * @param {Float64Array}  gravity - [gx, gy, gz]
   * @param {number}        delta   - Time step in seconds
   */
  static _verletIntegrate(chain, gravity, delta) {
    const pos  = chain.positions;
    const prev = chain.prevPositions;
    const pull = chain.pull;
    const count = chain.particleCount;
    const dt2 = delta * delta;

    for (let i = 1; i < count; i++) {
      const ix = i * 3;
      const iy = ix + 1;
      const iz = ix + 2;

      // velocity = pos - prevPos
      const vx = pos[ix] - prev[ix];
      const vy = pos[iy] - prev[iy];
      const vz = pos[iz] - prev[iz];

      // prevPos = pos (save current as previous)
      prev[ix] = pos[ix];
      prev[iy] = pos[iy];
      prev[iz] = pos[iz];

      // damping factor
      const damping = 1 - pull[i];

      // pos += velocity * (1 - pull) + gravity * delta²
      pos[ix] += vx * damping + gravity[0] * dt2;
      pos[iy] += vy * damping + gravity[1] * dt2;
      pos[iz] += vz * damping + gravity[2] * dt2;
    }
  }

  /**
   * Propagate object inertia to all non-root particles.
   * Shifts both current and previous positions by the displacement vector,
   * so particles move with the model and implicit velocity is preserved.
   *
   * @param {object}       chain          - ChainData object
   * @param {Float64Array}  objectInertia  - [dx, dy, dz] model displacement this frame
   */
  static _propagateInertia(chain, objectInertia) {
    const pos  = chain.positions;
    const prev = chain.prevPositions;
    const count = chain.particleCount;
    const dx = objectInertia[0];
    const dy = objectInertia[1];
    const dz = objectInertia[2];

    for (let i = 1; i < count; i++) {
      const ix = i * 3;
      const iy = ix + 1;
      const iz = ix + 2;

      pos[ix]  += dx;
      pos[iy]  += dy;
      pos[iz]  += dz;

      prev[ix] += dx;
      prev[iy] += dy;
      prev[iz] += dz;
    }
  }

  /**
   * Apply spring (elasticity) force toward rest pose for every non-root particle.
   *
   * For each particle i (i >= 1):
   *   restTarget = parentPos + restLocalDirection[i] * boneLength[i]
   *   pos[i] += (restTarget - pos[i]) * spring[i]
   *
   * When spring = 0, no correction; when spring = 1, particle snaps to rest target.
   *
   * @param {object} chain - ChainData object
   */
  static _applyElasticity(chain) {
    const pos     = chain.positions;
    const spring  = chain.spring;
    const parents = chain.parentIndices;
    const restDir = chain.restLocalDirections;
    const lengths = chain.boneLengths;
    const count   = chain.particleCount;

    for (let i = 1; i < count; i++) {
      const s = spring[i];
      if (s === 0) continue; // no spring force

      const parentIdx = parents[i];
      const ix = i * 3;
      const iy = ix + 1;
      const iz = ix + 2;
      const px = parentIdx * 3;
      const py = px + 1;
      const pz = px + 2;
      const rx = i * 3;

      // restTarget = parentPos + restLocalDirection * boneLength
      const len = lengths[i];
      const rtx = pos[px] + restDir[rx]     * len;
      const rty = pos[py] + restDir[rx + 1] * len;
      const rtz = pos[pz] + restDir[rx + 2] * len;

      // pos += (restTarget - pos) * spring
      pos[ix] += (rtx - pos[ix]) * s;
      pos[iy] += (rty - pos[iy]) * s;
      pos[iz] += (rtz - pos[iz]) * s;
    }
  }

  /**
   * Apply stiffness limiting for every non-root particle.
   * Constrains the angle between the parent→particle direction and the
   * rest local direction to at most arccos(stiffness).
   *
   * When stiffness = 1, no deviation allowed (particle stays on rest direction).
   * When stiffness = 0, any angle is permitted (no clamping).
   *
   * Uses lerp + renormalize as a slerp approximation for angle clamping.
   *
   * @param {object} chain - ChainData object
   */
  static _applyStiffness(chain) {
    const pos     = chain.positions;
    const parents = chain.parentIndices;
    const restDir = chain.restLocalDirections;
    const stiff   = chain.stiffness;
    const count   = chain.particleCount;

    for (let i = 1; i < count; i++) {
      const s = stiff[i];
      if (s === 0) continue; // any angle permitted

      const parentIdx = parents[i];
      const ix = i * 3;
      const iy = ix + 1;
      const iz = ix + 2;
      const px = parentIdx * 3;
      const py = px + 1;
      const pz = px + 2;
      const rx = i * 3;

      // Current direction from parent to particle
      let cdx = pos[ix] - pos[px];
      let cdy = pos[iy] - pos[py];
      let cdz = pos[iz] - pos[pz];
      const len = Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz);
      if (len < 1e-10) continue; // degenerate, skip

      // Normalize current direction
      const invLen = 1.0 / len;
      cdx *= invLen;
      cdy *= invLen;
      cdz *= invLen;

      // Rest direction (already unit vector)
      const rdx = restDir[rx];
      const rdy = restDir[rx + 1];
      const rdz = restDir[rx + 2];

      // Dot product → current angle
      let dot = cdx * rdx + cdy * rdy + cdz * rdz;
      // Clamp to [-1, 1] for numerical safety
      if (dot > 1) dot = 1;
      else if (dot < -1) dot = -1;

      const currentAngle = Math.acos(dot);
      const maxAngle = Math.acos(s); // stiffness = cos(maxAngle)

      if (currentAngle > maxAngle && currentAngle > 1e-6) {
        // Interpolate between rest direction and current direction
        // t = maxAngle / currentAngle → lerp + renormalize (slerp approximation)
        const t = maxAngle / currentAngle;
        let nx = rdx + t * (cdx - rdx);
        let ny = rdy + t * (cdy - rdy);
        let nz = rdz + t * (cdz - rdz);
        const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nlen > 1e-10) {
          const invNlen = 1.0 / nlen;
          nx *= invNlen;
          ny *= invNlen;
          nz *= invNlen;
          // Reposition particle at clamped direction, preserving distance
          pos[ix] = pos[px] + nx * len;
          pos[iy] = pos[py] + ny * len;
          pos[iz] = pos[pz] + nz * len;
        }
      }
    }
  }

  /**
   * Enforce length constraint for every non-root particle.
   * Projects each particle onto a sphere of radius boneLength centered at
   * its parent, preserving the current direction.
   *
   * @param {object} chain - ChainData object
   */
  static _enforceLengthConstraint(chain) {
    const pos     = chain.positions;
    const parents = chain.parentIndices;
    const lengths = chain.boneLengths;
    const restDir = chain.restLocalDirections;
    const count   = chain.particleCount;

    for (let i = 1; i < count; i++) {
      const parentIdx = parents[i];
      const ix = i * 3;
      const iy = ix + 1;
      const iz = ix + 2;
      const px = parentIdx * 3;
      const py = px + 1;
      const pz = px + 2;

      // Direction from parent to particle
      const dx = pos[ix] - pos[px];
      const dy = pos[iy] - pos[py];
      const dz = pos[iz] - pos[pz];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const boneLen = lengths[i];

      if (dist > 1e-10) {
        // Project onto sphere of radius boneLength, preserving direction
        const scale = boneLen / dist;
        pos[ix] = pos[px] + dx * scale;
        pos[iy] = pos[py] + dy * scale;
        pos[iz] = pos[pz] + dz * scale;
      } else {
        // Degenerate case: place along rest direction
        const rx = i * 3;
        pos[ix] = pos[px] + restDir[rx]     * boneLen;
        pos[iy] = pos[py] + restDir[rx + 1] * boneLen;
        pos[iz] = pos[pz] + restDir[rx + 2] * boneLen;
      }
    }
  }

  /**
   * Execute one full simulation frame for a single particle chain.
   *
   * Step order:
   *   1. Inertia propagation
   *   2. Verlet integration + damping
   *   3. Elasticity (spring)
   *   4. Stiffness limiting
   *   5. Length constraint enforcement
   *   6. Collision response
   *
   * @param {object}       chain          - ChainData object
   * @param {object[]}     colliders      - Array of ColliderData objects
   * @param {Float64Array}  gravity        - [gx, gy, gz]
   * @param {number}        delta          - Time step in seconds
   * @param {Float64Array}  objectInertia  - [dx, dy, dz] model displacement this frame
   */
  static simulateChain(chain, colliders, gravity, delta, objectInertia) {
    // Guard: skip frame on invalid delta
    if (delta <= 0 || delta !== delta) return; // delta !== delta catches NaN

    // Clamp delta to prevent instability after long frame gaps
    delta = Math.min(delta, TUNING.MAX_DELTA);

    // 1. Inertia propagation
    ChainSimulator._propagateInertia(chain, objectInertia);

    // 2. Verlet integration + damping
    ChainSimulator._verletIntegrate(chain, gravity, delta);

    // 3. Elasticity (spring toward rest pose)
    ChainSimulator._applyElasticity(chain);

    // 4. Stiffness limiting (angle clamping)
    ChainSimulator._applyStiffness(chain);

    // 5. Length constraint enforcement
    ChainSimulator._enforceLengthConstraint(chain);

    // 6. Collision response
    ChainSimulator._resolveCollisions(chain, colliders);
  }

  /**
   * Resolve collisions between all non-root particles in a chain and the
   * provided colliders, respecting collision group/mask filtering.
   *
   * For each particle, iterates all colliders. A collider is tested only if
   * `(chain.collisionMask & (1 << collider.collisionGroup)) !== 0`.
   * Dispatches to CollisionSolver.resolveSphere or resolveCapsule based on
   * collider type.
   *
   * Requirements: 4.4, 4.5
   *
   * @param {object}   chain     - ChainData object
   * @param {object[]} colliders - Array of ColliderData objects
   */
  static _resolveCollisions(chain, colliders) {
    const pos   = chain.positions;
    const count = chain.particleCount;
    const mask  = chain.collisionMask;

    for (let i = 1; i < count; i++) {
      const offset = i * 3;
      for (let j = 0; j < colliders.length; j++) {
        const c = colliders[j];
        // Collision group/mask filtering (Req 4.5)
        if ((mask & (1 << c.collisionGroup)) === 0) continue;

        if (c.type === 'sphere') {
          CollisionSolver.resolveSphere(pos, offset, c.worldCenter, c.radius);
        } else if (c.type === 'capsule') {
          CollisionSolver.resolveCapsule(pos, offset, c.worldCenter, c.worldTailPos, c.radius);
        }
      }
    }
  }
}

// ─── PMXConverter ────────────────────────────────────────────────────────────
/**
 * Converts PMX rigid body and joint data into particle chains and colliders.
 * All methods are static. THREE.Euler / THREE.Vector3 usage is acceptable here
 * because conversion runs only at initialization, not per-frame.
 */
class PMXConverter {

  /**
   * Top-level conversion entry point.
   * Builds colliders from Mode 0 rigid bodies and particle chains from
   * Mode 1/2 rigid bodies, returning both.
   *
   * Requirements: 3.1
   *
   * @param {THREE.SkinnedMesh} mesh        - The MMD model mesh with skeleton
   * @param {object[]}          rigidBodies - PMX rigid body parameter array
   * @param {object[]}          joints      - PMX joint/constraint parameter array
   * @returns {{ chains: object[], colliders: object[] }}
   */
  static convert(mesh, rigidBodies, joints) {
    const colliders = PMXConverter._buildColliders(mesh, rigidBodies);
    const chains = PMXConverter._buildChains(mesh, rigidBodies, joints);
    return { chains, colliders };
  }

  /**
   * Convert Mode 0 (kinematic / FollowBone) rigid bodies into colliders.
   *
   * PMX shapeType mapping:
   *   0 = Sphere  → sphere collider
   *   1 = Box     → capsule collider (longest axis = capsule axis, shortest = radius)
   *   2 = Capsule → capsule collider
   *
   * Requirements: 3.4, 4.1, 4.6, 3.9
   *
   * @param {THREE.SkinnedMesh} mesh        - The MMD model mesh
   * @param {object[]}          rigidBodies - PMX rigid body parameter array
   * @returns {object[]} Array of ColliderData objects
   */
  static _buildColliders(mesh, rigidBodies) {
    const colliders = [];
    const bones = mesh.skeleton.bones;

    for (let i = 0; i < rigidBodies.length; i++) {
      const rb = rigidBodies[i];
      if (rb.physicsMode !== 0) continue; // Only Mode 0 (kinematic) → colliders

      // Skip if bone doesn't exist
      if (rb.boneIndex < 0 || rb.boneIndex >= bones.length) {
        console.warn(
          `[ParticleChainPhysics] Rigid body ${i} references non-existent bone ${rb.boneIndex}, skipping`
        );
        continue;
      }

      // Determine collider type from shape
      let colliderType, radius, halfLength;
      const size = rb.shapeSize; // [width, height, depth]

      if (rb.shapeType === 0) {
        // Sphere
        colliderType = 'sphere';
        radius = size[0];
        halfLength = 0;
      } else if (rb.shapeType === 1) {
        // Box → approximate as capsule
        // Per design (Req 4.6): box's longest axis as capsule axis, shortest axis as radius
        const dims = [size[0], size[1], size[2]];
        const maxDim = Math.max(...dims);
        const minDim = Math.min(...dims);
        colliderType = 'capsule';
        radius = minDim;
        halfLength = maxDim / 2;
      } else if (rb.shapeType === 2) {
        // Capsule
        colliderType = 'capsule';
        radius = size[0];
        halfLength = size[1] / 2;
      } else {
        console.warn(
          `[ParticleChainPhysics] Unknown shapeType ${rb.shapeType} for rigid body ${i}, skipping`
        );
        continue;
      }

      const collider = createColliderData(colliderType);
      collider.radius = radius;
      collider.halfLength = halfLength;
      collider.boneIndex = rb.boneIndex;
      collider.collisionGroup = rb.collisionGroup;
      collider.collisionMask = rb.collisionMask;

      // Store rigid body's shape position as local offset relative to bone.
      // shapePosition is already bone-relative after PMX parsing adjustments.
      // The actual world position will be computed each frame in
      // CollisionSolver.updateColliderTransforms.
      collider.localCenter[0] = rb.shapePosition[0];
      collider.localCenter[1] = rb.shapePosition[1];
      collider.localCenter[2] = rb.shapePosition[2];

      // For capsule, compute tail position along the capsule axis in local space
      if (colliderType === 'capsule' && halfLength > 0) {
        // Capsule axis is along local Y by default in PMX.
        // Apply rigid body rotation to get the actual axis direction.
        const euler = new THREE.Euler(
          rb.shapeRotation[0], rb.shapeRotation[1], rb.shapeRotation[2]
        );
        const axis = new THREE.Vector3(0, 1, 0).applyEuler(euler);

        // localCenter = center - axis * halfLength  (endpoint A)
        // localTailPos = center + axis * halfLength  (endpoint B)
        collider.localCenter[0] = rb.shapePosition[0] - axis.x * halfLength;
        collider.localCenter[1] = rb.shapePosition[1] - axis.y * halfLength;
        collider.localCenter[2] = rb.shapePosition[2] - axis.z * halfLength;
        collider.localTailPos[0] = rb.shapePosition[0] + axis.x * halfLength;
        collider.localTailPos[1] = rb.shapePosition[1] + axis.y * halfLength;
        collider.localTailPos[2] = rb.shapePosition[2] + axis.z * halfLength;
      }

      colliders.push(collider);
    }

    return colliders;
  }

  /**
   * Convert Mode 1 (Physics) and Mode 2 (PhysicsWithBone) rigid bodies into
   * particle chains by traversing the bone hierarchy depth-first.
   *
   * Algorithm:
   *   1. Build boneIndex → rigidBody map for Mode 1/2 bodies
   *   2. Build boneIndex → joint map for parameter mapping
   *   3. Build parent→children map for the bone hierarchy
   *   4. Find chain roots: Mode 1/2 bones whose parent is NOT Mode 1/2
   *   5. DFS-collect connected Mode 1/2 bones into chains
   *   6. Root particle of each chain = the kinematic parent bone
   *
   * Requirements: 3.1, 3.2, 3.3, 3.8
   *
   * @param {THREE.SkinnedMesh} mesh        - The MMD model mesh
   * @param {object[]}          rigidBodies - PMX rigid body parameter array
   * @param {object[]}          joints      - PMX joint/constraint parameter array
   * @returns {object[]} Array of ChainData objects
   */
  static _buildChains(mesh, rigidBodies, joints) {
    const bones = mesh.skeleton.bones;
    const chains = [];

    // ── Map: boneIndex → rigidBody (for Mode 1 and Mode 2 only) ──
    const boneToRB = new Map();
    for (let i = 0; i < rigidBodies.length; i++) {
      const rb = rigidBodies[i];
      if (rb.physicsMode === 1 || rb.physicsMode === 2) {
        if (rb.boneIndex >= 0 && rb.boneIndex < bones.length) {
          boneToRB.set(rb.boneIndex, rb);
        } else {
          console.warn(
            `[ParticleChainPhysics] Rigid body ${i} (Mode ${rb.physicsMode}) references non-existent bone ${rb.boneIndex}, skipping`
          );
        }
      }
    }

    // ── Map: rigidBody index → joint (keyed by rigidbodyIndexB) ──
    // This lets us look up the joint that constrains a given rigid body.
    const rbIndexByBone = new Map(); // boneIndex → index into rigidBodies[]
    for (let i = 0; i < rigidBodies.length; i++) {
      rbIndexByBone.set(rigidBodies[i].boneIndex, i);
    }
    const jointMap = new Map(); // rigidBody array index → joint
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      jointMap.set(j.rigidbodyIndexB, j);
    }

    // ── Build parent→children map for the bone hierarchy ──
    const childrenMap = new Map();
    for (let i = 0; i < bones.length; i++) {
      const parent = bones[i].parent;
      if (parent) {
        const parentIdx = bones.indexOf(parent);
        if (parentIdx >= 0) {
          if (!childrenMap.has(parentIdx)) childrenMap.set(parentIdx, []);
          childrenMap.get(parentIdx).push(i);
        }
      }
    }

    // ── DFS collection of connected Mode 1/2 bones ──
    const visited = new Set();

    function collectChainDFS(boneIdx, chainBones) {
      if (visited.has(boneIdx)) return;
      if (!boneToRB.has(boneIdx)) return;
      visited.add(boneIdx);
      chainBones.push(boneIdx);

      const children = childrenMap.get(boneIdx) || [];
      for (const childIdx of children) {
        if (boneToRB.has(childIdx)) {
          collectChainDFS(childIdx, chainBones);
        }
      }
    }

    // ── Find all chain start points and build chains ──
    for (const [boneIdx] of boneToRB) {
      if (visited.has(boneIdx)) continue;

      // Find the kinematic root (parent bone that is NOT Mode 1/2)
      let rootBoneIdx = -1;
      const bone = bones[boneIdx];
      if (bone.parent) {
        const parentBoneIdx = bones.indexOf(bone.parent);
        if (parentBoneIdx >= 0 && !boneToRB.has(parentBoneIdx)) {
          rootBoneIdx = parentBoneIdx;
        }
      }
      if (rootBoneIdx === -1) {
        // No kinematic parent found; use the bone itself as root
        rootBoneIdx = boneIdx;
      }

      // Collect all Mode 1/2 bones in this chain via DFS
      const chainBones = [];
      collectChainDFS(boneIdx, chainBones);

      if (chainBones.length === 0) continue;

      // ── Create ChainData: root particle + dynamic particles ──
      const particleCount = 1 + chainBones.length; // root + dynamics
      const chain = createChainData(particleCount);
      chain.rootBoneIndex = rootBoneIdx;

      // Particle 0 = root (kinematic, follows bone)
      chain.boneIndices[0] = rootBoneIdx;
      chain.parentIndices[0] = -1;
      chain.boneLengths[0] = 0;
      chain.pull[0] = 1;      // root doesn't move
      chain.spring[0] = 1;
      chain.stiffness[0] = 1;

      // Get root bone world position
      const rootBone = bones[rootBoneIdx];
      rootBone.updateWorldMatrix(true, false);
      const rootWorldPos = new THREE.Vector3();
      rootWorldPos.setFromMatrixPosition(rootBone.matrixWorld);
      chain.positions[0] = rootWorldPos.x;
      chain.positions[1] = rootWorldPos.y;
      chain.positions[2] = rootWorldPos.z;
      chain.restPositions[0] = rootWorldPos.x;
      chain.restPositions[1] = rootWorldPos.y;
      chain.restPositions[2] = rootWorldPos.z;
      chain.prevPositions[0] = rootWorldPos.x;
      chain.prevPositions[1] = rootWorldPos.y;
      chain.prevPositions[2] = rootWorldPos.z;

      // Set collision group/mask from first dynamic rigid body
      const firstRB = boneToRB.get(chainBones[0]);
      chain.collisionGroup = firstRB.collisionGroup;
      chain.collisionMask = firstRB.collisionMask;

      // ── Fill dynamic particles ──
      for (let p = 0; p < chainBones.length; p++) {
        const idx = p + 1; // particle index (0 is root)
        const dynBoneIdx = chainBones[p];
        const dynRB = boneToRB.get(dynBoneIdx);
        const dynBone = bones[dynBoneIdx];

        chain.boneIndices[idx] = dynBoneIdx;

        // Find parent particle index:
        // The parent bone of this dynamic bone should be either the root
        // or another dynamic bone already in the chain.
        let parentParticleIdx = 0; // default to root
        if (dynBone.parent) {
          const parentBoneIdx = bones.indexOf(dynBone.parent);
          for (let q = 0; q < idx; q++) {
            if (chain.boneIndices[q] === parentBoneIdx) {
              parentParticleIdx = q;
              break;
            }
          }
        }
        chain.parentIndices[idx] = parentParticleIdx;

        // World position
        dynBone.updateWorldMatrix(true, false);
        const worldPos = new THREE.Vector3();
        worldPos.setFromMatrixPosition(dynBone.matrixWorld);
        const ox = idx * 3;
        chain.positions[ox]     = worldPos.x;
        chain.positions[ox + 1] = worldPos.y;
        chain.positions[ox + 2] = worldPos.z;
        chain.restPositions[ox]     = worldPos.x;
        chain.restPositions[ox + 1] = worldPos.y;
        chain.restPositions[ox + 2] = worldPos.z;
        chain.prevPositions[ox]     = worldPos.x;
        chain.prevPositions[ox + 1] = worldPos.y;
        chain.prevPositions[ox + 2] = worldPos.z;

        // Bone length = distance to parent particle
        const ppx = parentParticleIdx * 3;
        const dx = chain.positions[ox]     - chain.positions[ppx];
        const dy = chain.positions[ox + 1] - chain.positions[ppx + 1];
        const dz = chain.positions[ox + 2] - chain.positions[ppx + 2];
        chain.boneLengths[idx] = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Rest local direction (unit vector from parent to this particle)
        const bLen = chain.boneLengths[idx];
        if (bLen > 1e-10) {
          chain.restLocalDirections[ox]     = dx / bLen;
          chain.restLocalDirections[ox + 1] = dy / bLen;
          chain.restLocalDirections[ox + 2] = dz / bLen;
        } else {
          chain.restLocalDirections[ox]     = 0;
          chain.restLocalDirections[ox + 1] = 1; // default: down
          chain.restLocalDirections[ox + 2] = 0;
        }

        // ── Map PMX parameters ──
        chain.pull[idx] = PMXConverter._mapPullFromDamping(dynRB.linearDamping);

        // Find joint for this rigid body to get stiffness
        const rbIdx = rbIndexByBone.get(dynBoneIdx);
        const joint = jointMap.get(rbIdx);
        chain.stiffness[idx] = joint
          ? PMXConverter._mapStiffnessFromJoint(joint)
          : TUNING.DEFAULT_STIFFNESS;

        // Map spring, with Mode 2 boost (Req 3.3)
        let springVal = PMXConverter._mapSpringFromRestitution(dynRB.repulsion);
        if (dynRB.physicsMode === 2) {
          springVal = Math.min(springVal * TUNING.MODE2_SPRING_BOOST, 1.0);
        }
        chain.spring[idx] = springVal;
      }

      chains.push(chain);
    }

    return chains;
  }

  // ── PMX Parameter Mapping Functions ──────────────────────────────────────

  /**
   * Map PMX linear damping to Pull parameter.
   * Pull = clamp(linearDamping, 0, 1)
   *
   * Requirements: 3.6
   *
   * @param {number} linearDamping - PMX rigid body linearDamping value
   * @returns {number} Pull value in [0, 1]
   */
  static _mapPullFromDamping(linearDamping) {
    return Math.max(0, Math.min(1, linearDamping));
  }

  /**
   * Map PMX restitution (repulsion) to Spring parameter.
   * Spring = clamp(repulsion * SPRING_SCALE, 0, 1)
   *
   * Requirements: 3.7
   *
   * @param {number} restitution - PMX rigid body repulsion value
   * @returns {number} Spring value in [0, 1]
   */
  static _mapSpringFromRestitution(restitution) {
    return Math.max(0, Math.min(1, restitution * TUNING.SPRING_SCALE));
  }

  /**
   * Map PMX joint angular spring values to Stiffness parameter.
   * Stiffness = clamp(avg(|springRotation|) / REF_MAX_SPRING, 0, 1)
   *
   * Requirements: 3.5
   *
   * @param {object} joint - PMX joint object with springRotation [x, y, z]
   * @returns {number} Stiffness value in [0, 1]
   */
  static _mapStiffnessFromJoint(joint) {
    const sr = joint.springRotation || [0, 0, 0];
    const avg = (Math.abs(sr[0]) + Math.abs(sr[1]) + Math.abs(sr[2])) / 3;
    return Math.max(0, Math.min(1, avg / TUNING.REF_MAX_SPRING));
  }
}

// ─── CollisionSolver ─────────────────────────────────────────────────────────
/**
 * Sphere and capsule collision detection and response.
 * All methods are static and operate directly on typed arrays — zero per-frame
 * allocations (Requirement 6.2). Uses the module-level _tempVec3 for
 * updateColliderTransforms.
 */
class CollisionSolver {

  /**
   * Sphere collision: if the particle is inside the sphere (distance to center
   * < radius), project it to the sphere surface along the center→particle
   * direction.
   *
   * Requirements: 4.1, 4.2
   *
   * @param {Float64Array} particlePos  - Particle positions array
   * @param {number}       offset       - Index into particlePos for this particle (x component)
   * @param {Float64Array} sphereCenter - [cx, cy, cz] world center of the sphere
   * @param {number}       radius       - Sphere radius
   * @returns {boolean} true if a collision was resolved
   */
  static resolveSphere(particlePos, offset, sphereCenter, radius) {
    const dx = particlePos[offset]     - sphereCenter[0];
    const dy = particlePos[offset + 1] - sphereCenter[1];
    const dz = particlePos[offset + 2] - sphereCenter[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < radius && dist > 1e-10) {
      const scale = radius / dist;
      particlePos[offset]     = sphereCenter[0] + dx * scale;
      particlePos[offset + 1] = sphereCenter[1] + dy * scale;
      particlePos[offset + 2] = sphereCenter[2] + dz * scale;
      return true;
    }
    return false;
  }

  /**
   * Capsule collision: find the closest point on the capsule axis segment
   * (from capsuleA to capsuleB). If the particle's distance to that closest
   * point is less than the capsule radius, project the particle to the
   * capsule surface.
   *
   * Requirements: 4.1, 4.2
   *
   * @param {Float64Array} particlePos - Particle positions array
   * @param {number}       offset      - Index into particlePos for this particle (x component)
   * @param {Float64Array} capsuleA    - [ax, ay, az] world endpoint A of capsule axis
   * @param {Float64Array} capsuleB    - [bx, by, bz] world endpoint B of capsule axis
   * @param {number}       radius      - Capsule radius
   * @returns {boolean} true if a collision was resolved
   */
  static resolveCapsule(particlePos, offset, capsuleA, capsuleB, radius) {
    // Vector from A to B (capsule axis)
    const abx = capsuleB[0] - capsuleA[0];
    const aby = capsuleB[1] - capsuleA[1];
    const abz = capsuleB[2] - capsuleA[2];

    // Vector from A to particle
    const apx = particlePos[offset]     - capsuleA[0];
    const apy = particlePos[offset + 1] - capsuleA[1];
    const apz = particlePos[offset + 2] - capsuleA[2];

    // Project AP onto AB to find closest point parameter t
    const abLenSq = abx * abx + aby * aby + abz * abz;
    let t = 0;
    if (abLenSq > 1e-10) {
      t = (apx * abx + apy * aby + apz * abz) / abLenSq;
      t = Math.max(0, Math.min(1, t)); // clamp to segment
    }

    // Closest point on segment
    const cx = capsuleA[0] + abx * t;
    const cy = capsuleA[1] + aby * t;
    const cz = capsuleA[2] + abz * t;

    // Distance from particle to closest point
    const dx = particlePos[offset]     - cx;
    const dy = particlePos[offset + 1] - cy;
    const dz = particlePos[offset + 2] - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < radius && dist > 1e-10) {
      const scale = radius / dist;
      particlePos[offset]     = cx + dx * scale;
      particlePos[offset + 1] = cy + dy * scale;
      particlePos[offset + 2] = cz + dz * scale;
      return true;
    }
    return false;
  }

  /**
   * Update all colliders' world-space coordinates from their associated bones'
   * current matrixWorld transforms. Called once per frame before collision
   * detection.
   *
   * Uses the module-level _tempVec3 to avoid per-frame allocations (Req 6.2).
   *
   * Requirements: 4.3
   *
   * @param {object[]}          colliders - Array of ColliderData objects
   * @param {THREE.SkinnedMesh} mesh      - The MMD model mesh with skeleton
   */
  static updateColliderTransforms(colliders, mesh) {
    const bones = mesh.skeleton.bones;

    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (c.boneIndex < 0 || c.boneIndex >= bones.length) continue;

      const bone = bones[c.boneIndex];

      // Transform localCenter to world
      _tempVec3.set(c.localCenter[0], c.localCenter[1], c.localCenter[2]);
      _tempVec3.applyMatrix4(bone.matrixWorld);
      c.worldCenter[0] = _tempVec3.x;
      c.worldCenter[1] = _tempVec3.y;
      c.worldCenter[2] = _tempVec3.z;

      // Transform localTailPos to world (for capsules)
      if (c.type === 'capsule') {
        _tempVec3.set(c.localTailPos[0], c.localTailPos[1], c.localTailPos[2]);
        _tempVec3.applyMatrix4(bone.matrixWorld);
        c.worldTailPos[0] = _tempVec3.x;
        c.worldTailPos[1] = _tempVec3.y;
        c.worldTailPos[2] = _tempVec3.z;
      }
    }
  }
}

// ─── BoneWriteback ───────────────────────────────────────────────────────────
/**
 * Converts particle positions back to bone rotations in the Three.js skeleton.
 * Only writes rotation (quaternion), never modifies bone local position.
 * Uses module-level pre-allocated _tempQuat, _restDir, _curDir for zero
 * per-frame allocations (Requirement 6.2).
 *
 * Requirements: 5.1, 5.2, 5.3, 5.5
 */
class BoneWriteback {

  /**
   * Write particle positions back as bone rotations for a single chain.
   *
   * Processes particles in order 1, 2, 3, ... (parent-to-child, since chains
   * are built depth-first). For each particle i (i >= 1):
   *   1. Get the parent particle's bone
   *   2. Compute current direction: particle[i].pos - particle[parentIdx].pos
   *   3. Get rest direction from chain.restLocalDirections[i]
   *   4. Compute rotation quaternion from rest → current via setFromUnitVectors
   *   5. Apply rotation to parent bone's quaternion
   *   6. Call bone.updateMatrixWorld(true) so children get correct parent transform
   *
   * @param {object}            chain - ChainData object
   * @param {THREE.SkinnedMesh} mesh  - The MMD model mesh with skeleton
   */
  static writeBack(chain, mesh) {
    const pos     = chain.positions;
    const parents = chain.parentIndices;
    const restDir = chain.restLocalDirections;
    const boneIdx = chain.boneIndices;
    const bones   = mesh.skeleton.bones;
    const count   = chain.particleCount;

    for (let i = 1; i < count; i++) {
      const parentParticleIdx = parents[i];
      const parentBoneIndex   = boneIdx[parentParticleIdx];
      const parentBone        = bones[parentBoneIndex];
      if (!parentBone) continue;

      const ix = i * 3;
      const px = parentParticleIdx * 3;

      // Current direction: particle[i] - particle[parent] (normalized)
      _curDir.set(
        pos[ix]     - pos[px],
        pos[ix + 1] - pos[px + 1],
        pos[ix + 2] - pos[px + 2]
      );
      const len = _curDir.length();
      if (len < 1e-10) continue; // degenerate, skip
      _curDir.multiplyScalar(1.0 / len);

      // Rest direction (already unit vector)
      _restDir.set(restDir[ix], restDir[ix + 1], restDir[ix + 2]);

      // Compute rotation from rest direction to current direction
      _tempQuat.setFromUnitVectors(_restDir, _curDir);

      // Apply rotation to parent bone's quaternion (preserves local position)
      parentBone.quaternion.multiply(_tempQuat);

      // Update world matrix so child bones get correct parent transform
      parentBone.updateMatrixWorld(true);
    }
  }
}

// ─── ParticleChainPhysics ────────────────────────────────────────────────────
/**
 * Main physics engine class. Manages all particle chains and colliders,
 * orchestrates per-frame simulation, and provides the public API
 * (update, reset, dispose, warmup, setGravity, serialize, deserialize).
 *
 * Requirements: 7.1, 8.1, 6.2
 */
class ParticleChainPhysics {

  /**
   * @param {THREE.SkinnedMesh} mesh           - The MMD model mesh with skeleton
   * @param {object[]}          rigidBodyParams - PMX rigid body parameter array
   * @param {object[]}          jointParams     - PMX joint/constraint parameter array
   */
  constructor(mesh, rigidBodyParams, jointParams) {
    this.mesh = mesh;

    // Convert PMX data to particle chains and colliders
    const { chains, colliders } = PMXConverter.convert(mesh, rigidBodyParams, jointParams);
    this.chains = chains;
    this.colliders = colliders;

    // Pre-allocate gravity
    this.gravity = new Float64Array(3);
    this.gravity[0] = TUNING.GRAVITY[0];
    this.gravity[1] = TUNING.GRAVITY[1];
    this.gravity[2] = TUNING.GRAVITY[2];

    // Pre-allocate object inertia tracking
    this._objectInertia = new Float64Array(3);
    this._lastMeshPos = new Float64Array(3);

    // Initialize last mesh position
    const worldPos = new THREE.Vector3();
    mesh.getWorldPosition(worldPos);
    this._lastMeshPos[0] = worldPos.x;
    this._lastMeshPos[1] = worldPos.y;
    this._lastMeshPos[2] = worldPos.z;
  }

  /**
   * Execute one full simulation frame.
   *
   * Steps:
   *   1. Compute object inertia (model displacement this frame)
   *   2. Update collider world transforms
   *   3. Update root particle positions (kinematic, follow bone)
   *   4. Simulate each chain
   *   5. Write back bone transforms
   *
   * Requirements: 7.1, 7.2, 5.4
   *
   * @param {number} delta - Time step in seconds
   */
  update(delta) {
    // Guard: skip on invalid delta
    if (delta <= 0 || delta !== delta) return;
    delta = Math.min(delta, TUNING.MAX_DELTA);

    const mesh = this.mesh;
    if (!mesh) return;

    // 1. Compute object inertia (model displacement this frame)
    _tempVec3.set(0, 0, 0);
    mesh.getWorldPosition(_tempVec3);
    this._objectInertia[0] = _tempVec3.x - this._lastMeshPos[0];
    this._objectInertia[1] = _tempVec3.y - this._lastMeshPos[1];
    this._objectInertia[2] = _tempVec3.z - this._lastMeshPos[2];
    this._lastMeshPos[0] = _tempVec3.x;
    this._lastMeshPos[1] = _tempVec3.y;
    this._lastMeshPos[2] = _tempVec3.z;

    // 2. Update collider world transforms
    CollisionSolver.updateColliderTransforms(this.colliders, mesh);

    // 3. Update root particle positions (kinematic, follow bone)
    const bones = mesh.skeleton.bones;
    for (let c = 0; c < this.chains.length; c++) {
      const chain = this.chains[c];
      const rootBone = bones[chain.rootBoneIndex];
      if (rootBone) {
        _tempVec3.setFromMatrixPosition(rootBone.matrixWorld);
        chain.positions[0] = _tempVec3.x;
        chain.positions[1] = _tempVec3.y;
        chain.positions[2] = _tempVec3.z;
      }
    }

    // 4. Simulate each chain
    for (let c = 0; c < this.chains.length; c++) {
      ChainSimulator.simulateChain(
        this.chains[c], this.colliders, this.gravity, delta, this._objectInertia
      );
    }

    // 5. Write back bone transforms
    for (let c = 0; c < this.chains.length; c++) {
      BoneWriteback.writeBack(this.chains[c], mesh);
    }
  }

  /**
   * Reset all particles to their rest pose positions and clear velocity.
   * Requirements: 8.3
   */
  reset() {
    for (let c = 0; c < this.chains.length; c++) {
      const chain = this.chains[c];
      chain.positions.set(chain.restPositions);
      chain.prevPositions.set(chain.restPositions);
    }
  }

  /**
   * Release all references to Three.js objects and internal data structures.
   * Requirements: 8.2
   */
  dispose() {
    this.mesh = null;
    this.chains = null;
    this.colliders = null;
    this.gravity = null;
    this._objectInertia = null;
    this._lastMeshPos = null;
  }

  /**
   * Pre-simulate the specified number of frames to stabilize physics state.
   * Requirements: 7.4
   *
   * @param {number} cycles - Number of simulation steps to run
   */
  warmup(cycles) {
    const dt = 1 / 60;
    for (let i = 0; i < cycles; i++) {
      this.update(dt);
    }
  }

  /**
   * Update the gravity vector used for simulation.
   *
   * @param {THREE.Vector3|number[]} gravity - New gravity vector
   */
  setGravity(gravity) {
    if (gravity.isVector3) {
      this.gravity[0] = gravity.x;
      this.gravity[1] = gravity.y;
      this.gravity[2] = gravity.z;
    } else {
      this.gravity[0] = gravity[0] || 0;
      this.gravity[1] = gravity[1] || 0;
      this.gravity[2] = gravity[2] || 0;
    }
  }

  /**
   * Export all chain configurations, collider definitions, and global
   * parameters as a JSON-compatible object.
   * Requirements: 9.1
   *
   * @returns {object} Serialized engine state
   */
  serialize() {
    const data = {
      version: 1,
      gravity: Array.from(this.gravity),
      chains: [],
      colliders: [],
    };

    for (const chain of this.chains) {
      data.chains.push({
        particleCount: chain.particleCount,
        rootBoneIndex: chain.rootBoneIndex,
        boneIndices: Array.from(chain.boneIndices),
        parentIndices: Array.from(chain.parentIndices),
        boneLengths: Array.from(chain.boneLengths),
        pull: Array.from(chain.pull),
        spring: Array.from(chain.spring),
        stiffness: Array.from(chain.stiffness),
        restLocalDirections: Array.from(chain.restLocalDirections),
        restPositions: Array.from(chain.restPositions),
        collisionGroup: chain.collisionGroup,
        collisionMask: chain.collisionMask,
      });
    }

    for (const collider of this.colliders) {
      data.colliders.push({
        type: collider.type,
        radius: collider.radius,
        halfLength: collider.halfLength,
        localCenter: Array.from(collider.localCenter),
        localTailPos: Array.from(collider.localTailPos),
        boneIndex: collider.boneIndex,
        collisionGroup: collider.collisionGroup,
        collisionMask: collider.collisionMask,
      });
    }

    return data;
  }

  /**
   * Restore engine state from a previously serialized JSON object.
   * Validates structure; uses defaults for missing fields with console.warn.
   * Rejects if chain/particle count mismatches.
   * Requirements: 9.2, 9.3, 9.4
   *
   * @param {object} data - Serialized engine state from serialize()
   */
  deserialize(data) {
    if (!data || typeof data !== 'object') {
      console.error('[ParticleChainPhysics] Invalid deserialize data');
      return;
    }

    // Validate chain count matches
    if (data.chains && data.chains.length !== this.chains.length) {
      console.error(
        `[ParticleChainPhysics] Chain count mismatch: data has ${data.chains.length}, engine has ${this.chains.length}`
      );
      return;
    }

    // Restore gravity
    if (data.gravity) {
      this.gravity[0] = data.gravity[0] ?? TUNING.GRAVITY[0];
      this.gravity[1] = data.gravity[1] ?? TUNING.GRAVITY[1];
      this.gravity[2] = data.gravity[2] ?? TUNING.GRAVITY[2];
    }

    // Restore chain parameters
    if (data.chains) {
      for (let c = 0; c < this.chains.length; c++) {
        const chain = this.chains[c];
        const src = data.chains[c];

        if (src.particleCount !== chain.particleCount) {
          console.error(`[ParticleChainPhysics] Particle count mismatch in chain ${c}`);
          return;
        }

        // Restore per-particle parameters with defaults for missing fields
        const fields = ['pull', 'spring', 'stiffness'];
        const defaults = [TUNING.DEFAULT_PULL, TUNING.DEFAULT_SPRING, TUNING.DEFAULT_STIFFNESS];
        for (let f = 0; f < fields.length; f++) {
          const fieldName = fields[f];
          if (src[fieldName]) {
            for (let i = 0; i < chain.particleCount; i++) {
              chain[fieldName][i] = src[fieldName][i] ?? defaults[f];
            }
          } else {
            console.warn(
              `[ParticleChainPhysics] Missing field '${fieldName}' in chain ${c}, using defaults`
            );
            chain[fieldName].fill(defaults[f]);
          }
        }
      }
    }

    // Reset positions after parameter restore
    this.reset();
  }
}

// ─── MMDParticleChainPhysics Factory ─────────────────────────────────────────
/**
 * Factory function matching the MMDAmmoPhysics interface signature.
 * Allows MMD.setPhysics() to switch seamlessly between engines.
 *
 * Requirements: 7.1, 1.2
 *
 * @param {object} mmd - MMD model object with mesh, pmx, grants, iks
 * @returns {object} Physics wrapper with update, reset, dispose, etc.
 */
const MMDParticleChainPhysics = (mmd) => {
  const physics = new ParticleChainPhysics(mmd.mesh, mmd.pmx.rigidBodies, mmd.pmx.joints);
  physics.warmup(10);
  return {
    createHelper: () => null,  // debug visualization not yet supported
    reset:       () => physics.reset(),
    update:      (delta) => physics.update(delta),
    setGravity:  (gravity) => physics.setGravity(gravity),
    getPhysics:  () => physics,
    dispose:     () => physics.dispose(),
    serialize:   () => physics.serialize(),
    deserialize: (data) => physics.deserialize(data),
    warmup:      (cycles) => physics.warmup(cycles),
  };
};

export {
  TUNING,
  createChainData,
  createColliderData,
  ChainSimulator,
  PMXConverter,
  CollisionSolver,
  BoneWriteback,
  ParticleChainPhysics,
  MMDParticleChainPhysics,
};
