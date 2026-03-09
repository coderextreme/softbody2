let physicsWorld, scene, camera, renderer, controls;
let clock = new THREE.Clock();
let rigidBodies = [];
let softBodies = [];
let parsedBodiesMap = {};
let globalHinge = null;
let armMovement = 0;
const margin = 0.05;

let transformAux1;

// Ensure the page is fully parsed before executing
window.addEventListener('load', () => {

    if (typeof Ammo === 'undefined') {
        document.getElementById('container').innerHTML = "<br><br><br><b>Error:</b> Ammo.js failed to load from the CDN. Please check your network/adblocker.";
        console.error("Ammo.js is undefined. The CDN script tag failed to execute.");
        return;
    }

    // Initialize Ammo.js
    Ammo().then((AmmoLib) => {
        window.Ammo = AmmoLib;
        transformAux1 = new Ammo.btTransform();

        initGraphics();
        initPhysics();
        initInput();

        // Fetch X3D JSON and parse it
        fetch('scene.json')
            .then(response => {
                if (!response.ok) throw new Error("Could not load scene.json");
                return response.json();
            })
            .then(json => {
                parseSceneJSON(json.X3D.Scene);
                animate();
            })
            .catch(err => console.error("Error loading scene.json:", err));
    });
});

function initGraphics() {
    const container = document.getElementById('container');
    container.innerHTML = ""; // Clear loading messages

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.2, 2000);
    camera.position.set(-14, 12, 12);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xbfd1e5);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 3, 0);

    scene.add(new THREE.AmbientLight(0x404040));
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(-7, 15, 15);
    light.castShadow = true;
    const d = 15;
    light.shadow.camera.left = -d; light.shadow.camera.right = d;
    light.shadow.camera.top = d; light.shadow.camera.bottom = -d;
    scene.add(light);

    window.addEventListener('resize', onWindowResize, false);
}

function initPhysics() {
    const collisionConfiguration = new Ammo.btSoftBodyRigidBodyCollisionConfiguration();
    const dispatcher = new Ammo.btCollisionDispatcher(collisionConfiguration);
    const broadphase = new Ammo.btDbvtBroadphase();
    const solver = new Ammo.btSequentialImpulseConstraintSolver();
    const softBodySolver = new Ammo.btDefaultSoftBodySolver();

    physicsWorld = new Ammo.btSoftRigidDynamicsWorld(dispatcher, broadphase, solver, collisionConfiguration, softBodySolver);
}

function parseSceneJSON(sceneData) {
    let collection = null;

    // Extract RigidBodyCollection from the -children array if it exists
    if (sceneData["-children"]) {
        const targetChild = sceneData["-children"].find(child => child.RigidBodyCollection);
        if (targetChild) {
            collection = targetChild.RigidBodyCollection;
        }
    } else if (sceneData.RigidBodyCollection) {
        // Fallback for previous structure
        collection = sceneData.RigidBodyCollection;
    }

    if (!collection) {
        console.error("No RigidBodyCollection found in Scene -children.");
        return;
    }

    const gravity = collection["@gravity"];
    physicsWorld.setGravity(new Ammo.btVector3(gravity[0], gravity[1], gravity[2]));
    physicsWorld.getWorldInfo().set_m_gravity(new Ammo.btVector3(gravity[0], gravity[1], gravity[2]));

    // 1. Parse Bodies (RigidBody and SoftBody are both stored in -bodies)
    if (collection["-bodies"]) {
        collection["-bodies"].forEach(bodyNode => {
            if (bodyNode.RigidBody) {
                const rb = bodyNode.RigidBody;
                const mass = rb["@mass"];
                const pos = rb["@position"];
                const def = rb["@DEF"];

                // Extract from MFNode array structure
                const geomField = rb["-geometry"];
                const collidableShapeNode = Array.isArray(geomField) ? geomField[0] : geomField;
                const shapeNode = collidableShapeNode?.CollidableShape?.["-shape"]?.Shape;

                const size = shapeNode?.["-geometry"]?.Box?.["@size"] || [1, 1, 1];
                const col = shapeNode?.["-appearance"]?.Appearance?.["-material"]?.Material?.["@diffuseColor"] || [Math.random(), Math.random(), Math.random()];

                createRigidBody(def, size, mass, pos, col);

            } else if (bodyNode.SoftBody) {
                const sb = bodyNode.SoftBody;

                // Extract from MFNode array structure
                const geomField = sb["-geometry"];
                const collidableShapeNode = Array.isArray(geomField) ? geomField[0] : geomField;
                const shapeNode = collidableShapeNode?.CollidableShape?.["-shape"]?.Shape;

                const geometryNode = shapeNode?.["-geometry"];
                const col = shapeNode?.["-appearance"]?.Appearance?.["-material"]?.Material?.["@diffuseColor"] || [0.8, 0.8, 0.8];

                // Determine type based on inner geometry node
                if (geometryNode?.ElevationGrid) {
                    createSoftBodyCloth(sb, shapeNode, col);
                } else if (geometryNode?.Sphere) {
                    createSoftBodySphere(sb, shapeNode, col);
                }
            }
        });
    }

    // 2. Parse Joints (SingleAxisHingeJoint and Stitch are both stored in -joints)
    if (collection["-joints"]) {
        collection["-joints"].forEach(jointNode => {
            if (jointNode.SingleAxisHingeJoint) {
                createHinge(jointNode.SingleAxisHingeJoint);
            } else if (jointNode.Stitch) {
                createStitch(jointNode.Stitch);
            }
        });
    }
}

function createRigidBody(def, size, mass, pos, colorArray) {
    const [sx, sy, sz] = size;
    const material = new THREE.MeshPhongMaterial({ color: new THREE.Color(...colorArray) });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.position.set(pos[0], pos[1], pos[2]);

    const shape = new Ammo.btBoxShape(new Ammo.btVector3(sx * 0.5, sy * 0.5, sz * 0.5));
    shape.setMargin(margin);

    const transform = new Ammo.btTransform();
    transform.setIdentity();
    transform.setOrigin(new Ammo.btVector3(pos[0], pos[1], pos[2]));
    const motionState = new Ammo.btDefaultMotionState(transform);

    const localInertia = new Ammo.btVector3(0, 0, 0);
    shape.calculateLocalInertia(mass, localInertia);

    const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
    const body = new Ammo.btRigidBody(rbInfo);

    mesh.userData.physicsBody = body;
    scene.add(mesh);

    if (mass > 0) {
        rigidBodies.push(mesh);
        body.setActivationState(4); // Disable deactivation
    }
    physicsWorld.addRigidBody(body);
    if (def) parsedBodiesMap[def] = { mesh, body };
}

function createSoftBodyCloth(sbConfig, shapeNode, colorArray) {
    const pos = sbConfig["@position"];
    const mass = sbConfig["@mass"];

    // Fetch geometry details dynamically from X3D ElevationGrid
    const grid = shapeNode?.["-geometry"]?.ElevationGrid;
    const xDim = grid?.["@xDimension"] || 36;
    const zDim = grid?.["@zDimension"] || 26;
    const xSpacing = grid?.["@xSpacing"] || 0.2;
    const zSpacing = grid?.["@zSpacing"] || 0.2;

    // Convert ElevationGrid definitions back to width, height, and segments expected by Three/Ammo
    const segZ = xDim - 1;
    const segY = zDim - 1;
    const width = segZ * xSpacing;
    const height = segY * zSpacing;

    // BufferGeometry to represent cloth
    const geometry = new THREE.PlaneBufferGeometry(width, height, segZ, segY);
    geometry.rotateY(Math.PI * 0.5);
    geometry.translate(pos[0], pos[1] + height * 0.5, pos[2] - width * 0.5);

    const material = new THREE.MeshLambertMaterial({ color: new THREE.Color(...colorArray), side: THREE.DoubleSide });
    const clothMesh = new THREE.Mesh(geometry, material);
    clothMesh.castShadow = true; clothMesh.receiveShadow = true;

    // Disable frustum culling so the dynamically moving vertices don't disappear when the original bounding box is off screen
    clothMesh.frustumCulled = false;

    scene.add(clothMesh);

    // Ammo SoftBody
    const softBodyHelpers = new Ammo.btSoftBodyHelpers();
    const corner00 = new Ammo.btVector3(pos[0], pos[1] + height, pos[2]);
    const corner01 = new Ammo.btVector3(pos[0], pos[1] + height, pos[2] - width);
    const corner10 = new Ammo.btVector3(pos[0], pos[1], pos[2]);
    const corner11 = new Ammo.btVector3(pos[0], pos[1], pos[2] - width);

    const clothSoftBody = softBodyHelpers.CreatePatch(physicsWorld.getWorldInfo(), corner00, corner01, corner10, corner11, segZ + 1, segY + 1, 0, true);

    const sbCfg = clothSoftBody.get_m_cfg();
    sbCfg.set_viterations(10);
    sbCfg.set_piterations(10);
    clothSoftBody.setTotalMass(mass, false);
    Ammo.castObject(clothSoftBody, Ammo.btCollisionObject).getCollisionShape().setMargin(margin * 3);

    physicsWorld.addSoftBody(clothSoftBody, 1, -1);
    clothMesh.userData.physicsBody = clothSoftBody;
    clothMesh.userData.isCloth = true;
    clothSoftBody.setActivationState(4);

    const def = sbConfig["@DEF"];
    if (def) parsedBodiesMap[def] = { mesh: clothMesh, body: clothSoftBody, isSoft: true };
    softBodies.push(clothMesh);
}

function createSoftBodySphere(sbConfig, shapeNode, colorArray) {
    const pos = sbConfig["@position"];
    const mass = sbConfig["@mass"];

    // Fetch properties dynamically from X3D Sphere Geometry
    const sphere = shapeNode?.["-geometry"]?.Sphere;
    const radius = sphere?.["@radius"] || 1.0;

    // Icosahedron detail=3 for smooth surface matching
    const geometry = new THREE.IcosahedronBufferGeometry(radius, 3);
    geometry.translate(pos[0], pos[1], pos[2]);

    const material = new THREE.MeshLambertMaterial({ color: new THREE.Color(...colorArray) });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true; mesh.receiveShadow = true;

    // Disable frustum culling so the ball remains visible entirely as it drops
    mesh.frustumCulled = false;

    scene.add(mesh);

    const softBodyHelpers = new Ammo.btSoftBodyHelpers();
    const center = new Ammo.btVector3(pos[0], pos[1], pos[2]);
    const radiusVec = new Ammo.btVector3(radius, radius, radius);

    // Create soft body ellipsoid (res = 256 nodes)
    const softBody = softBodyHelpers.CreateEllipsoid(physicsWorld.getWorldInfo(), center, radiusVec, 256);

    const sbCfg = softBody.get_m_cfg();
    sbCfg.set_viterations(10);
    sbCfg.set_piterations(10);
    sbCfg.set_kDF(0.1);  // Dynamic friction
    sbCfg.set_kDP(0.01); // Damping

    // Drastically lower internal pressure so it squishes rather than staying rigid
    sbCfg.set_kPR(10);

    const sbMat = softBody.get_m_materials().at(0);
    // Lower stiffness parameters across the board to let the geometry deform
    sbMat.set_m_kLST(0.15); // Linear stiffness
    sbMat.set_m_kAST(0.1);  // Angular stiffness
    sbMat.set_m_kVST(0.1);  // Volume stiffness

    softBody.setTotalMass(mass, false);
    Ammo.castObject(softBody, Ammo.btCollisionObject).getCollisionShape().setMargin(margin);

    // Generate bending constraints to help it return to shape slowly
    softBody.generateBendingConstraints(2, sbMat);

    physicsWorld.addSoftBody(softBody, 1, -1);

    mesh.userData.physicsBody = softBody;
    mesh.userData.isSphere = true;
    softBody.setActivationState(4);

    // Map Three.js geometry vertices to the closest Ammo.js SoftBody node
    const nodes = softBody.get_m_nodes();
    const numNodes = nodes.size();
    const mapping = [];
    const positions = geometry.attributes.position.array;

    for (let i = 0; i < positions.length / 3; i++) {
        let vx = positions[i * 3], vy = positions[i * 3 + 1], vz = positions[i * 3 + 2];
        let minDist = Infinity;
        let minIdx = -1;
        for (let j = 0; j < numNodes; j++) {
            let nodePos = nodes.at(j).get_m_x();
            let dx = vx - nodePos.x();
            let dy = vy - nodePos.y();
            let dz = vz - nodePos.z();
            let dist = dx * dx + dy * dy + dz * dz;
            if (dist < minDist) {
                minDist = dist;
                minIdx = j;
            }
        }
        mapping.push(minIdx);
    }
    mesh.userData.mapping = mapping;

    const def = sbConfig["@DEF"];
    if (def) parsedBodiesMap[def] = { mesh, body: softBody, isSoft: true };

    Ammo.destroy(center);
    Ammo.destroy(radiusVec);

    softBodies.push(mesh);
}

function createHinge(jointConfig) {
    // Extract the body names from the nested SFNode structures
    const b1Name = jointConfig["-body1"]?.RigidBody?.["@USE"] || jointConfig["@body1"];
    const b2Name = jointConfig["-body2"]?.RigidBody?.["@USE"] || jointConfig["@body2"];

    const b1 = parsedBodiesMap[b1Name];
    const b2 = parsedBodiesMap[b2Name];
    const ap = jointConfig["@anchorPoint"];
    const ax = jointConfig["@axis"];

    if (!b1 || !b2) {
        console.warn(`Hinge creation failed: Missing one or both connected bodies (${b1Name}, ${b2Name})`);
        return;
    }

    const pA = new Ammo.btVector3(ap[0] - b1.mesh.position.x, ap[1] - b1.mesh.position.y, ap[2] - b1.mesh.position.z);
    const pB = new Ammo.btVector3(ap[0] - b2.mesh.position.x, ap[1] - b2.mesh.position.y, ap[2] - b2.mesh.position.z);
    const axis = new Ammo.btVector3(ax[0], ax[1], ax[2]);

    globalHinge = new Ammo.btHingeConstraint(b1.body, b2.body, pA, pB, axis, axis, true);
    physicsWorld.addConstraint(globalHinge, true);
}

function createStitch(stitchConfig) {
    // Extract rigid body and soft body names from nested SFNode structures
    const rbName = stitchConfig["-body1"]?.RigidBody?.["@USE"] || stitchConfig["@body1"];
    const sbName = stitchConfig["-body2"]?.SoftBody?.["@USE"] || stitchConfig["@body2"];

    const rbEntry = parsedBodiesMap[rbName];
    const sbEntry = parsedBodiesMap[sbName];

    if (!rbEntry || !sbEntry) {
        console.warn(`Stitch creation failed: Missing rigid body (${rbName}) or soft body (${sbName})`);
        return;
    }

    // Parse space-separated index and weight lists
    const indices = (stitchConfig["@body1Index"] || "").trim().split(/\s+/).map(Number);
    const weights = (stitchConfig["@weight"] || "").trim().split(/\s+/).map(Number);

    const softBody = sbEntry.body;
    indices.forEach((nodeIndex, i) => {
        const weight = weights[i] !== undefined ? weights[i] : 1.0;
        softBody.appendAnchor(nodeIndex, rbEntry.body, false, weight);
    });
}


function initInput() {
    window.addEventListener('keydown', (e) => {
        if (e.keyCode === 81) armMovement = 1; // Q
        if (e.keyCode === 65) armMovement = -1; // A
    }, false);
    window.addEventListener('keyup', () => armMovement = 0, false);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    const deltaTime = clock.getDelta();

    if (globalHinge) globalHinge.enableAngularMotor(true, 0.8 * armMovement, 50);

    physicsWorld.stepSimulation(deltaTime, 10);

    // Update Soft Bodies
    softBodies.forEach(mesh => {
        const softBody = mesh.userData.physicsBody;
        const positions = mesh.geometry.attributes.position.array;
        const nodes = softBody.get_m_nodes();

        if (mesh.userData.isSphere) {
            // Volume Mapping logic
            const mapping = mesh.userData.mapping;
            for (let i = 0; i < mapping.length; i++) {
                const nodePos = nodes.at(mapping[i]).get_m_x();
                positions[i * 3]     = nodePos.x();
                positions[i * 3 + 1] = nodePos.y();
                positions[i * 3 + 2] = nodePos.z();
            }
        } else {
            // Cloth logic
            const numVerts = positions.length / 3;
            let idx = 0;
            for (let i = 0; i < numVerts; i++) {
                const nodePos = nodes.at(i).get_m_x();
                positions[idx++] = nodePos.x();
                positions[idx++] = nodePos.y();
                positions[idx++] = nodePos.z();
            }
        }

        mesh.geometry.computeVertexNormals();
        mesh.geometry.attributes.position.needsUpdate = true;
        mesh.geometry.attributes.normal.needsUpdate = true;
    });

    // Update Rigid Bodies
    rigidBodies.forEach(obj => {
        const ms = obj.userData.physicsBody.getMotionState();
        if (ms) {
            ms.getWorldTransform(transformAux1);
            const p = transformAux1.getOrigin();
            const q = transformAux1.getRotation();
            obj.position.set(p.x(), p.y(), p.z());
            obj.quaternion.set(q.x(), q.y(), q.z(), q.w());
        }
    });

    controls.update();
    renderer.render(scene, camera);
}
