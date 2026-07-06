// State Management Variables
let network = null;
let nodesDataSet = null;
let edgesDataSet = null;

let walkthroughSequence = [];
let currentStep = -1;
let nodesTable = {};
let activeNodeId = null;

// Graph Cache to enable reactive client-side toggling and focal subgraph filtering
let cachedNodes = [];
let cachedEdges = [];
let cachedRepoDirName = "";

// Set of all nodes currently visible in the accumulative graph traversal view
const visibleNodeIds = new Set();

// Local coordinate cache (nodeId -> {x, y}) to prevent layout wiggles/shifts
const nodeCoords = {};

// Global animation array for smooth parent-relative child node slide-outs
let animatingNodes = [];

// Interpolated cursor coordinates for smooth magnetic sliding cursor
let cursorX = null;
let cursorY = null;

// Inspected node and timeout tracking for client-side LLM request debouncing
let inspectedNodeId = null;
let explainDebounceTimeout = null;

// History Navigation Back Stack
const navStack = [];

// DOM Elements
const repoUrlInput = document.getElementById("repo-url-input");
const analyzeBtn = document.getElementById("analyze-btn");
const statusIndicator = document.getElementById("status-indicator");
const statusLabel = statusIndicator.querySelector(".label");
const canvasLoader = document.getElementById("canvas-loader");

const noSelectionMessage = document.getElementById("no-selection-message");
const nodeDetailsContainer = document.getElementById("node-details-container");
const nodeTypeBadge = document.getElementById("node-type");
const nodeNameEl = document.getElementById("node-name");
const nodeFileLink = document.getElementById("node-file-link");
const nodeLinesEl = document.getElementById("node-lines");
const nodeScopeEl = document.getElementById("node-scope");
const nodeExplanationEl = document.getElementById("node-explanation");
const explanationLoader = document.getElementById("explanation-loader");
const nodeCodeBlock = document.getElementById("node-code-block");
const outboundCallsList = document.getElementById("outbound-calls-list");

const stepNumberEl = document.getElementById("step-number");
const prevStepBtn = document.getElementById("prev-step-btn");
const nextStepBtn = document.getElementById("next-step-btn");
const restartWalkBtn = document.getElementById("restart-walk-btn");
const goBackBtn = document.getElementById("go-back-btn");
const startNodeIndicator = document.getElementById("walkthrough-start-node");
const toggleLibraryNodes = document.getElementById("toggle-library-nodes");

// Helper: set UI status
function setStatus(status, text) {
    statusIndicator.className = `status-indicator ${status}`;
    statusLabel.textContent = text;
}

// Navigation Back Stack Helpers
function pushNavState() {
    if (activeNodeId) {
        navStack.push({
            sequence: [...walkthroughSequence],
            currentStep: currentStep,
            activeNodeId: activeNodeId
        });
        updateGoBackBtn();
    }
}

// Global animation frame ID
let animationFrameId = null;

function clearNavStack() {
    navStack.length = 0;
    updateGoBackBtn();
}

function updateGoBackBtn() {
    if (goBackBtn) {
        goBackBtn.disabled = navStack.length === 0;
    }
}

// Format local file path to trigger OS / IDE click
function formatFileLink(filepath, startRow) {
    return `file:///${filepath}#L${startRow + 1}`;
}

// Convert absolute filepath to relative path
function getRelPath(filepath, repoDirName) {
    if (!filepath) return "";
    const idx = filepath.indexOf("/" + repoDirName + "/");
    if (idx !== -1) {
        return filepath.substring(idx + repoDirName.length + 2);
    }
    return filepath.split('/').pop();
}

// 1. Analyze and Load Graph
analyzeBtn.addEventListener("click", performAnalysis);
repoUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") performAnalysis();
});

function performAnalysis() {
    const url = repoUrlInput.value.trim();
    if (!url) return;

    setStatus("loading", "Analyzing...");
    canvasLoader.classList.remove("hidden");
    analyzeBtn.disabled = true;

    fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url })
    })
    .then(res => {
        if (!res.ok) throw new Error("Analysis failed");
        return res.json();
    })
    .then(data => {
        setStatus("success", "Analyzed");
        return loadGraph(data.repo_dir);
    })
    .catch(err => {
        console.error(err);
        setStatus("error", "Failed");
        alert("Failed to analyze repository. Check if Ollama is running and model is loaded.");
    })
    .finally(() => {
        canvasLoader.classList.add("hidden");
        analyzeBtn.disabled = false;
    });
}

function loadGraph(repoDirName) {
    return fetch("/api/graph")
        .then(res => res.json())
        .then(data => {
            // Cache data globally
            cachedNodes = data.nodes;
            cachedEdges = data.edges;
            cachedRepoDirName = repoDirName;
            
            renderGraph(data.nodes, data.edges, repoDirName);
            return startWalkthrough(null);
        });
}

// Initialize datasets and Network exactly once
function initNetwork() {
    if (network) return;

    nodesDataSet = new vis.DataSet([]);
    edgesDataSet = new vis.DataSet([]);

    const container = document.getElementById("network-canvas");
    const graphData = {
        nodes: nodesDataSet,
        edges: edgesDataSet
    };

    // Physics disabled: all transitions and coordinates are calculated and animated manually
    const options = {
        layout: {
            hierarchical: {
                enabled: false // Disabled completely
            }
        },
        physics: {
            enabled: false // Disabled completely to prevent wiggles
        },
        interaction: {
            hover: true,
            selectConnectedEdges: false,
            tooltipDelay: 200
        }
    };

    network = new vis.Network(container, graphData, options);

    // Click Node inside graph
    network.on("click", function(params) {
        if (params.nodes.length > 0) {
            const clickedId = params.nodes[0];

            pushNavState();

            if (clickedId.startsWith("library_entity:")) {
                selectLibraryNode(clickedId);
                return;
            }

            // Start walkthrough from the clicked node
            startWalkthrough(clickedId);
        }
    });

    // Keep coordinate cache updated when user drags a node manually
    network.on("dragEnd", function(params) {
        if (params.nodes.length > 0) {
            const draggedId = params.nodes[0];
            const pos = network.getPositions([draggedId])[draggedId];
            if (pos) {
                nodeCoords[draggedId] = { x: pos.x, y: pos.y };
                nodesDataSet.update({ id: draggedId, x: pos.x, y: pos.y });
            }
        }
    });

    // Draw concentric blue active node cursor ring with LERP sliding interpolation
    network.on("afterDrawing", function(ctx) {
        if (activeNodeId && nodeCoords[activeNodeId]) {
            try {
                const targetPos = nodeCoords[activeNodeId];
                if (targetPos) {
                    // Initialize cursor position if not yet set
                    if (cursorX === null || cursorY === null) {
                        cursorX = targetPos.x;
                        cursorY = targetPos.y;
                    } else {
                        // Linear interpolation (LERP): smooth sliding towards active node position
                        const ease = 0.08;
                        cursorX += (targetPos.x - cursorX) * ease;
                        cursorY += (targetPos.y - cursorY) * ease;
                    }

                    const time = Date.now() * 0.0035;
                    const pulseOffset = Math.sin(time) * 3; // range -3 to +3

                    // Inner Blue Ring
                    ctx.strokeStyle = "rgba(59, 130, 246, 0.85)";
                    ctx.lineWidth = 2.5;
                    ctx.beginPath();
                    ctx.arc(cursorX, cursorY, 35, 0, 2 * Math.PI);
                    ctx.stroke();

                    // Outer Pulsing Blue Ring
                    ctx.strokeStyle = "rgba(59, 130, 246, 0.28)";
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(cursorX, cursorY, 42 + pulseOffset, 0, 2 * Math.PI);
                    ctx.stroke();
                }
            } catch (e) {
                // Canvas details not loaded yet
            }
        }
    });

    // Continuous animation loop request to make the active cursor pulse and update node coordinates manually
    const pulseLoop = () => {
        let needsRedraw = false;

        // Perform manual node coordinate LERP transitions for sliding children out of parents
        if (animatingNodes.length > 0) {
            const nextAnimating = [];
            animatingNodes.forEach(item => {
                const node = nodesDataSet.get(item.id);
                if (node) {
                    let currX = node.x !== undefined ? node.x : item.targetX;
                    let currY = node.y !== undefined ? node.y : item.targetY;

                    const dx = item.targetX - currX;
                    const dy = item.targetY - currY;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < 1.0) {
                        // Snapped to target coordinate
                        nodesDataSet.update({ id: item.id, x: item.targetX, y: item.targetY });
                        nodeCoords[item.id] = { x: item.targetX, y: item.targetY };
                    } else {
                        // LERP easing step
                        const ease = 0.12;
                        currX += dx * ease;
                        currY += dy * ease;
                        nodesDataSet.update({ id: item.id, x: currX, y: currY });
                        nodeCoords[item.id] = { x: currX, y: currY };
                        nextAnimating.push(item);
                    }
                    needsRedraw = true;
                }
            });
            animatingNodes = nextAnimating;
        }

        if (network && (activeNodeId || needsRedraw)) {
            network.redraw();
        }
        animationFrameId = requestAnimationFrame(pulseLoop);
    };
    pulseLoop();
}

// Caches nodes/edges data and structures the lookup table
function renderGraph(backendNodes, backendEdges, repoDirName) {
    cachedNodes = backendNodes;
    cachedEdges = backendEdges;
    cachedRepoDirName = repoDirName;

    nodesTable = {};
    backendNodes.forEach(node => {
        nodesTable[node.id] = node;
    });

    visibleNodeIds.clear();
    for (let key in nodeCoords) delete nodeCoords[key];
    animatingNodes = [];
    cursorX = null;
    cursorY = null;

    // Set up network elements and clear dataset content
    initNetwork();
    nodesDataSet.clear();
    edgesDataSet.clear();
}

// Helper: Resolve target positions so nodes do not overlap
function findNonOverlappingPos(targetX, targetY, excludeNodeId) {
    const minDistance = 110; // Minimum safety distance between node centers
    let resolvedY = targetY;
    let resolvedX = targetX;
    let iterations = 0;
    const maxIterations = 50;
    
    let foundOverlap = true;
    while (foundOverlap && iterations < maxIterations) {
        foundOverlap = false;
        
        // Check against all nodes currently in nodeCoords
        for (const nid in nodeCoords) {
            if (nid === excludeNodeId) continue;
            
            const pos = nodeCoords[nid];
            const dx = resolvedX - pos.x;
            const dy = resolvedY - pos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist < minDistance) {
                foundOverlap = true;
                // Shift vertically
                resolvedY += (dy >= 0 ? 100 : -100);
                // Add a tiny random horizontal jitter to break symmetry
                resolvedX += (Math.random() - 0.5) * 12;
                break;
            }
        }
        iterations++;
    }
    
    return { x: resolvedX, y: resolvedY };
}

// 2. Render Focal Subgraph View (dynamically updating datasets using coordinate cache)
function updateFocalSubgraph(activeNodeId) {
    if (!activeNodeId) return;

    // Ensure Vis.js is initialized
    initNetwork();

    const showLibrary = toggleLibraryNodes ? toggleLibraryNodes.checked : false;

    // 1. Find all newly introduced node IDs to calculate parent coordinates
    const newNodes = [];
    visibleNodeIds.forEach(nid => {
        if (!nodesDataSet || !nodesDataSet.get(nid)) {
            newNodes.push(nid);
        }
    });

    // Group new nodes by their respective parent (so we can spread them vertically to the right)
    const parentToNewChildren = {};
    newNodes.forEach(nid => {
        let parentId = activeNodeId; // Default parent is the active node
        cachedEdges.forEach(edge => {
            if (edge.to === nid && visibleNodeIds.has(edge.from)) {
                parentId = edge.from;
            }
        });

        if (!parentToNewChildren[parentId]) {
            parentToNewChildren[parentId] = [];
        }
        parentToNewChildren[parentId].push(nid);
    });

    // Calculate target nodes and edges set
    const targetNodes = [];
    const targetNodeIdsSet = new Set();
    const targetEdges = [];

    // Map all nodes currently in visibleNodeIds Set
    visibleNodeIds.forEach(nid => {
        let node = cachedNodes.find(n => n.id === nid);
        if (node) {
            targetNodeIdsSet.add(nid);
            let label = node.name;
            if (node.type === "class_definition") {
                label = `class ${node.name}`;
            }

            const isActive = nid === activeNodeId;
            const isOutboundTarget = cachedEdges.some(e => e.from === activeNodeId && e.to === nid);
            const bg = isActive ? '#fbbf24' : (isOutboundTarget ? '#f43f5e' : '#4f46e5');
            const border = isActive ? '#fbbf24' : (isOutboundTarget ? '#f43f5e' : '#6366f1');

            let nodeProperties = {
                id: node.id,
                label: label,
                title: `${node.type.replace('_', ' ')}: ${node.name}\nFile: ${getRelPath(node.filepath, cachedRepoDirName)}`,
                shape: 'dot',
                size: isActive ? 26 : (node.type === "class_definition" ? 22 : 16),
                color: {
                    background: bg,
                    border: border,
                    highlight: { background: '#fbbf24', border: '#fbbf24' },
                    hover: { background: '#6366f1', border: '#818cf8' }
                },
                font: {
                    face: 'Inter',
                    color: isActive ? '#fbbf24' : (isOutboundTarget ? '#f43f5e' : '#f1f2f6'),
                    size: isActive ? 14 : 13,
                    vadjust: 4
                },
                shadow: true,
                borderWidth: isActive ? 3 : 2,
                borderWidthSelected: 3
            };

            // Lock existing nodes at current coordinates to prevent layout shifts/jumps
            if (nodeCoords[nid]) {
                nodeProperties.x = nodeCoords[nid].x;
                nodeProperties.y = nodeCoords[nid].y;
                nodeProperties.fixed = { x: true, y: true };
            } else {
                // For new nodes, look up their parent node on the canvas to place them to the right
                let parentId = activeNodeId;
                cachedEdges.forEach(edge => {
                    if (edge.to === nid && visibleNodeIds.has(edge.from)) {
                        parentId = edge.from;
                    }
                });

                let px = 100, py = 300;
                let hasParentPos = false;
                if (parentId !== nid && nodeCoords[parentId]) {
                    px = nodeCoords[parentId].x;
                    py = nodeCoords[parentId].y;
                    hasParentPos = true;
                }

                const siblings = parentToNewChildren[parentId] || [nid];
                const idx = siblings.indexOf(nid);
                const total = siblings.length;

                const rawX = px + 220;
                const rawY = py + (idx - (total - 1) / 2) * 110;

                const resolved = findNonOverlappingPos(rawX, rawY, nid);
                const targetX = resolved.x;
                const targetY = resolved.y;

                // Clear previous animation entry for this node if we are recalculating it
                animatingNodes = animatingNodes.filter(item => item.id !== nid);
                
                if (hasParentPos) {
                    // Start at the parent node position and slide out smoothly
                    nodeProperties.x = px;
                    nodeProperties.y = py;
                    nodeProperties.fixed = { x: true, y: true };
                    nodeCoords[nid] = { x: px, y: py };
                    
                    animatingNodes.push({
                        id: nid,
                        targetX: targetX,
                        targetY: targetY
                    });
                } else {
                    // If no parent pos is resolved (like step 0), place it immediately
                    nodeProperties.x = targetX;
                    nodeProperties.y = targetY;
                    nodeProperties.fixed = { x: true, y: true };
                    nodeCoords[nid] = { x: targetX, y: targetY };
                }
            }

            targetNodes.push(nodeProperties);
        } else if (nid.startsWith("library_entity:")) {
            targetNodeIdsSet.add(nid);
            const libName = nid.split(":", 1)[1] || nid;
            if (!nodesTable[nid]) {
                nodesTable[nid] = {
                    id: nid,
                    name: libName,
                    type: "library_call",
                    filepath: "External",
                    start_row: 0,
                    end_row: 0,
                    code: "External Library Entity"
                };
            }

            let nodeProperties = {
                id: nid,
                label: libName,
                shape: 'dot',
                size: 10,
                color: {
                    background: cachedEdges.some(e => e.from === activeNodeId && e.to === nid) ? '#f43f5e' : '#1e293b',
                    border: cachedEdges.some(e => e.from === activeNodeId && e.to === nid) ? '#f43f5e' : '#475569',
                    highlight: { background: '#94a3b8', border: '#cbd5e1' }
                },
                font: { face: 'Inter', color: cachedEdges.some(e => e.from === activeNodeId && e.to === nid) ? '#f43f5e' : '#94a3b8', size: 10 },
                borderWidth: 1,
                shadow: false
            };

            if (nodeCoords[nid]) {
                nodeProperties.x = nodeCoords[nid].x;
                nodeProperties.y = nodeCoords[nid].y;
                nodeProperties.fixed = { x: true, y: true };
            } else {
                let parentId = activeNodeId;
                cachedEdges.forEach(edge => {
                    if (edge.to === nid && visibleNodeIds.has(edge.from)) {
                        parentId = edge.from;
                    }
                });

                let px = 100, py = 300;
                let hasParentPos = false;
                if (parentId !== nid && nodeCoords[parentId]) {
                    px = nodeCoords[parentId].x;
                    py = nodeCoords[parentId].y;
                    hasParentPos = true;
                }

                const siblings = parentToNewChildren[parentId] || [nid];
                const idx = siblings.indexOf(nid);
                const total = siblings.length;

                const rawX = px + 220;
                const rawY = py + (idx - (total - 1) / 2) * 110;

                const resolved = findNonOverlappingPos(rawX, rawY, nid);
                const targetX = resolved.x;
                const targetY = resolved.y;

                animatingNodes = animatingNodes.filter(item => item.id !== nid);

                if (hasParentPos) {
                    nodeProperties.x = px;
                    nodeProperties.y = py;
                    nodeProperties.fixed = { x: true, y: true };
                    nodeCoords[nid] = { x: px, y: py };
                    
                    animatingNodes.push({
                        id: nid,
                        targetX: targetX,
                        targetY: targetY
                    });
                } else {
                    nodeProperties.x = targetX;
                    nodeProperties.y = targetY;
                    nodeProperties.fixed = { x: true, y: true };
                    nodeCoords[nid] = { x: targetX, y: targetY };
                }
            }

            targetNodes.push(nodeProperties);
        }
    });

    // Add edges where both endpoints are currently in visibleNodeIds Set
    cachedEdges.forEach(edge => {
        if (visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)) {
            let isTargetUserDefined = cachedNodes.some(n => n.id === edge.to);

            // Skip library edges if filter is active
            if (!showLibrary && !isTargetUserDefined) {
                return;
            }

            const isActiveOutbound = edge.from === activeNodeId;
            let color = isActiveOutbound ? '#f43f5e' : 'rgba(255, 255, 255, 0.2)';
            let width = isActiveOutbound ? 3 : 1;
            let dashes = false;

            if (!isActiveOutbound) {
                if (edge.type === 'thread_target') {
                    color = '#10b981'; // Green
                } else if (edge.type === 'callback') {
                    color = '#ef4444'; // Red
                } else if (!isTargetUserDefined) {
                    color = 'rgba(148, 163, 184, 0.3)'; // Muted Slate
                    dashes = true;
                }
            }

            const edgeId = edge.id || `${edge.from}->${edge.to}`;
            targetEdges.push({
                id: edgeId,
                from: edge.from,
                to: edge.to,
                arrows: 'to',
                dashes: dashes,
                width: width,
                color: {
                    color: color,
                    highlight: '#fbbf24',
                    hover: 'rgba(255,255,255,0.4)'
                },
                smooth: {
                    type: 'cubicBezier',
                    roundness: 0.4
                }
            });
        }
    });

    // 2. Perform Differential Update on nodesDataSet to animate transitions smoothly
    const currentNodesInSet = new Set(nodesDataSet.getIds());

    // Remove obsolete nodes
    const nodesToRemove = [...currentNodesInSet].filter(id => !targetNodeIdsSet.has(id));
    if (nodesToRemove.length > 0) {
        nodesDataSet.remove(nodesToRemove);
    }

    // Add or Update target nodes
    targetNodes.forEach(node => {
        if (currentNodesInSet.has(node.id)) {
            nodesDataSet.update(node);
        } else {
            nodesDataSet.add(node);
        }
    });

    // 3. Perform Differential Update on edgesDataSet
    const currentEdgesInSet = new Set(edgesDataSet.getIds());
    const targetEdgeIdsSet = new Set(targetEdges.map(e => e.id));

    // Remove obsolete edges
    const edgesToRemove = [...currentEdgesInSet].filter(id => !targetEdgeIdsSet.has(id));
    if (edgesToRemove.length > 0) {
        edgesDataSet.remove(edgesToRemove);
    }

    // Add or Update target edges
    targetEdges.forEach(edge => {
        if (currentEdgesInSet.has(edge.id)) {
            edgesDataSet.update(edge);
        } else {
            edgesDataSet.add(edge);
        }
    });

    // Centering camera transition on active node
    if (network && activeNodeId && nodeCoords[activeNodeId]) {
        const pos = nodeCoords[activeNodeId];
        network.moveTo({
            position: { x: pos.x, y: pos.y },
            animation: {
                duration: 800,
                easingFunction: 'easeInOutQuad'
            }
        });
    }
}

// 3. Walkthrough Execution
function startWalkthrough(startNodeId) {
    let url = "/api/walkthrough";
    if (startNodeId) {
        url += `?start_id=${encodeURIComponent(startNodeId)}`;
    } else {
        clearNavStack();
        visibleNodeIds.clear();
        for (let key in nodeCoords) delete nodeCoords[key];
        animatingNodes = [];
        cursorX = null;
        cursorY = null;
    }

    return fetch(url)
        .then(res => res.json())
        .then(data => {
            walkthroughSequence = data.sequence;
            const startId = data.start_node_id;
            
            const startNode = nodesTable[startId];
            if (startNode) {
                startNodeIndicator.textContent = `Starting at: ${startNode.name}`;
            }

            if (walkthroughSequence.length > 0) {
                currentStep = 0;
                displayStep(walkthroughSequence[currentStep]);
            } else {
                currentStep = -1;
                updateWalkthroughButtons();
            }
        });
}

// Step to node ID
function displayStep(nodeId) {
    activeNodeId = nodeId;
    
    showNodeDetails(nodeId);
    
    // Accumulative growth: add active node and its immediate outbound callees
    visibleNodeIds.add(nodeId);
    const showLibrary = toggleLibraryNodes ? toggleLibraryNodes.checked : false;
    cachedEdges.forEach(edge => {
        const isTargetUserDefined = cachedNodes.some(n => n.id === edge.to);
        if (edge.from === nodeId) {
            if (showLibrary || isTargetUserDefined) {
                visibleNodeIds.add(edge.to);
            }
        }
    });
    
    // Dynamically update the dataset content (triggers smooth transitions)
    updateFocalSubgraph(nodeId);

    updateWalkthroughButtons();
}

function updateWalkthroughButtons() {
    if (walkthroughSequence.length === 0) {
        stepNumberEl.textContent = "Step 0 / 0";
        prevStepBtn.disabled = true;
        nextStepBtn.disabled = true;
        return;
    }

    stepNumberEl.textContent = `Step ${currentStep + 1} / ${walkthroughSequence.length}`;
    prevStepBtn.disabled = currentStep <= 0;
    nextStepBtn.disabled = currentStep >= walkthroughSequence.length - 1;
}


// Display Node Inspector Data
function showNodeDetails(nodeId) {
    noSelectionMessage.classList.add("hidden");
    nodeDetailsContainer.classList.remove("hidden");

    const node = nodesTable[nodeId];
    if (!node) return;

    nodeTypeBadge.textContent = node.type === "class_definition" ? "CLASS" : "FUNCTION";
    nodeTypeBadge.className = `badge type-badge ${node.type === "class_definition" ? 'class-mode' : ''}`;
    nodeNameEl.textContent = node.name;
    const isActive = nodeId === activeNodeId;
    const isOutboundTarget = cachedEdges.some(e => e.from === activeNodeId && e.to === nodeId);
    nodeNameEl.style.color = isActive ? "#fbbf24" : (isOutboundTarget ? "#f43f5e" : "#f1f2f6");
    
    const repoName = repoUrlInput.value.split('/').pop().replace('.git', '') || "cloned_repo";
    const relativeFile = getRelPath(node.filepath, repoName);
    nodeFileLink.textContent = relativeFile;
    nodeFileLink.href = formatFileLink(node.filepath, node.start_row);
    nodeLinesEl.textContent = `(Lines ${node.start_row + 1} - ${node.end_row + 1})`;
    
    nodeScopeEl.textContent = `Scope: ${node.hierarchical_name}`;

    nodeCodeBlock.textContent = "Loading source code...";
    fetch(`/api/node/details?node_id=${encodeURIComponent(nodeId)}`)
        .then(res => res.json())
        .then(data => {
            nodeCodeBlock.textContent = data.code || "# Code snippet not available";
        });

    outboundCallsList.innerHTML = "";
    if (network) {
        let hasOutbound = false;
        
        cachedEdges.forEach(edge => {
            if (edge.from === nodeId) {
                hasOutbound = true;
                const targetNode = nodesTable[edge.to];
                if (targetNode) {
                    const li = document.createElement("li");
                    li.className = "call-item";
                    
                    let edgeLabel = "Direct";
                    let badgeClass = "call-type-direct";
                    if (edge.to.startsWith("library_entity:")) {
                        edgeLabel = "Library";
                        badgeClass = "call-type-library";
                    } else if (edge.color && edge.color.color === '#10b981') {
                        edgeLabel = "Thread";
                        badgeClass = "call-type-thread";
                    } else if (edge.color && edge.color.color === '#ef4444') {
                        edgeLabel = "Callback";
                        badgeClass = "call-type-callback";
                    }

                    li.innerHTML = `
                        <span class="call-relation" style="color: #f43f5e; font-weight: 500;">${targetNode.name}</span>
                        <span class="call-type-badge ${badgeClass}">${edgeLabel}</span>
                    `;
                    
                    li.addEventListener("click", () => {
                        pushNavState();
                        if (edge.to.startsWith("library_entity:")) {
                            selectLibraryNode(edge.to);
                        } else {
                            startWalkthrough(edge.to);
                        }
                    });
                    
                    outboundCallsList.appendChild(li);
                }
            }
        });

        if (!hasOutbound) {
            outboundCallsList.innerHTML = `<li class="empty-list-text" style="font-size:12px; color:var(--text-muted); font-style:italic;">None (Leaf function)</li>`;
        }
    }

    inspectedNodeId = nodeId;

    if (explainDebounceTimeout) {
        clearTimeout(explainDebounceTimeout);
    }

    nodeExplanationEl.classList.add("hidden");
    explanationLoader.classList.remove("hidden");

    explainDebounceTimeout = setTimeout(() => {
        fetch(`/api/node/explain?node_id=${encodeURIComponent(nodeId)}`)
            .then(res => res.json())
            .then(data => {
                if (inspectedNodeId === nodeId) {
                    nodeExplanationEl.textContent = data.explanation || "No explanation generated.";
                    nodeExplanationEl.classList.remove("hidden");
                    explanationLoader.classList.add("hidden");
                }
            })
            .catch(err => {
                if (inspectedNodeId === nodeId) {
                    nodeExplanationEl.textContent = "Failed to communicate with local Ollama server.";
                    nodeExplanationEl.classList.remove("hidden");
                    explanationLoader.classList.add("hidden");
                }
            });
    }, 300);
}

function selectLibraryNode(libNodeId) {
    const node = nodesTable[libNodeId];
    if (!node) return;

    noSelectionMessage.classList.add("hidden");
    nodeDetailsContainer.classList.remove("hidden");

    nodeTypeBadge.textContent = "EXTERNAL LIBRARY";
    nodeTypeBadge.className = "badge type-badge library-mode";
    nodeNameEl.textContent = node.name;
    const isLibOutbound = cachedEdges.some(e => e.from === activeNodeId && e.to === libNodeId);
    nodeNameEl.style.color = isLibOutbound ? "#f43f5e" : "#94a3b8";
    nodeFileLink.textContent = "External Reference";
    nodeFileLink.removeAttribute("href");
    nodeLinesEl.textContent = "";
    nodeScopeEl.textContent = "Scope: Python Standard Library or Pip Module";
    nodeCodeBlock.textContent = "# Source code unavailable for third-party libraries";
    outboundCallsList.innerHTML = `<li class="empty-list-text" style="font-size:12px; color:var(--text-muted); font-style:italic;">None</li>`;
    
    inspectedNodeId = libNodeId;

    if (explainDebounceTimeout) {
        clearTimeout(explainDebounceTimeout);
    }

    nodeExplanationEl.classList.add("hidden");
    explanationLoader.classList.remove("hidden");

    explainDebounceTimeout = setTimeout(() => {
        fetch(`/api/node/explain?node_id=${encodeURIComponent(libNodeId)}`)
            .then(res => res.json())
            .then(data => {
                if (inspectedNodeId === libNodeId) {
                    nodeExplanationEl.textContent = data.explanation || `External library entity "${node.name}".`;
                    nodeExplanationEl.classList.remove("hidden");
                    explanationLoader.classList.add("hidden");
                }
            })
            .catch(err => {
                if (inspectedNodeId === libNodeId) {
                    nodeExplanationEl.textContent = `External call to library entity "${node.name}".`;
                    nodeExplanationEl.classList.remove("hidden");
                    explanationLoader.classList.add("hidden");
                }
            });
    }, 300);

    if (network) {
        if (nodesDataSet.get(libNodeId)) {
            network.selectNodes([libNodeId]);
        }
    }
}

// 4. Navigation Buttons Event Bindings
prevStepBtn.addEventListener("click", () => {
    if (currentStep > 0) {
        currentStep--;
        displayStep(walkthroughSequence[currentStep]);
    }
});

// Focus on next active node in walkthrough sequence
nextStepBtn.addEventListener("click", () => {
    if (currentStep < walkthroughSequence.length - 1) {
        currentStep++;
        displayStep(walkthroughSequence[currentStep]);
    }
});

restartWalkBtn.addEventListener("click", () => {
    if (walkthroughSequence.length > 0) {
        currentStep = 0;
        displayStep(walkthroughSequence[currentStep]);
    }
});

if (goBackBtn) {
    goBackBtn.addEventListener("click", () => {
        if (navStack.length > 0) {
            const prevState = navStack.pop();
            walkthroughSequence = prevState.sequence;
            currentStep = prevState.currentStep;
            activeNodeId = prevState.activeNodeId;
            
            displayStep(activeNodeId);
            updateGoBackBtn();
        }
    });
}

// Load the default graph on initial page boot
window.addEventListener("DOMContentLoaded", () => {
    setStatus("loading", "Loading database...");
    updateGoBackBtn();
    
    if (toggleLibraryNodes) {
        toggleLibraryNodes.addEventListener("change", () => {
            if (activeNodeId) {
                updateFocalSubgraph(activeNodeId);
            }
        });
    }

    fetch("/api/graph")
        .then(res => res.json())
        .then(data => {
            if (data.nodes && data.nodes.length > 0) {
                setStatus("success", "Loaded");
                const repoName = repoUrlInput.value.split('/').pop().replace('.git', '') || "cloned_repo";
                
                // Cache data globally
                cachedNodes = data.nodes;
                cachedEdges = data.edges;
                cachedRepoDirName = repoName;
                
                renderGraph(data.nodes, data.edges, repoName);
                startWalkthrough(null);
            } else {
                setStatus("idle", "Ready");
            }
        })
        .catch(() => {
            setStatus("idle", "Ready");
        });
});
