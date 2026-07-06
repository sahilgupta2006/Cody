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

function renderGraph(backendNodes, backendEdges, repoDirName) {
    cachedNodes = backendNodes;
    cachedEdges = backendEdges;
    cachedRepoDirName = repoDirName;

    nodesTable = {};
    backendNodes.forEach(node => {
        nodesTable[node.id] = node;
    });
}

// 2. Render Focal Subgraph View (dynamically showing visibleNodeIds Set)
function updateFocalSubgraph(activeNodeId) {
    if (!activeNodeId) return;

    const showLibrary = toggleLibraryNodes ? toggleLibraryNodes.checked : false;

    // 1. Build filtered visNodes and visEdges
    const visNodes = [];
    const visEdges = [];

    visibleNodeIds.forEach(nid => {
        let node = cachedNodes.find(n => n.id === nid);
        if (node) {
            let label = node.name;
            if (node.type === "class_definition") {
                label = `class ${node.name}`;
            }

            const isActive = nid === activeNodeId;
            const bg = isActive ? '#fbbf24' : '#4f46e5';
            const border = isActive ? '#fbbf24' : '#6366f1';

            visNodes.push({
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
                    color: '#f1f2f6',
                    size: isActive ? 14 : 13,
                    vadjust: 4
                },
                shadow: true,
                borderWidth: isActive ? 3 : 2,
                borderWidthSelected: 3
            });
        } else if (nid.startsWith("library_entity:")) {
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
            visNodes.push({
                id: nid,
                label: libName,
                shape: 'dot',
                size: 10,
                color: {
                    background: '#1e293b',
                    border: '#475569',
                    highlight: { background: '#94a3b8', border: '#cbd5e1' }
                },
                font: { face: 'Inter', color: '#94a3b8', size: 10 },
                borderWidth: 1,
                shadow: false
            });
        }
    });

    cachedEdges.forEach(edge => {
        if (visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)) {
            let isTargetUserDefined = cachedNodes.some(n => n.id === edge.to);

            // Skip library edges if filter is active
            if (!showLibrary && !isTargetUserDefined) {
                return;
            }

            let color = 'rgba(255, 255, 255, 0.2)';
            let dashes = false;

            if (edge.type === 'thread_target') {
                color = '#10b981'; // Green
            } else if (edge.type === 'callback') {
                color = '#ef4444'; // Red
            } else if (!isTargetUserDefined) {
                color = 'rgba(148, 163, 184, 0.3)'; // Muted Slate
                dashes = true;
            }

            visEdges.push({
                from: edge.from,
                to: edge.to,
                arrows: 'to',
                dashes: dashes,
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

    nodesDataSet = new vis.DataSet(visNodes);
    edgesDataSet = new vis.DataSet(visEdges);

    const container = document.getElementById("network-canvas");
    const graphData = {
        nodes: nodesDataSet,
        edges: edgesDataSet
    };

    // Hierarchical Left-to-Right layout centered on the active node
    const options = {
        layout: {
            hierarchical: {
                enabled: true,
                direction: 'LR',
                sortMethod: 'directed',
                nodeSpacing: 100,
                levelSeparation: 200,
                parentCentralization: true,
                edgeMinimization: true,
                blockShifting: true
            }
        },
        physics: {
            enabled: true,
            hierarchicalRepulsion: {
                centralGravity: 0.0,
                springLength: 90,
                springConstant: 0.01,
                nodeDistance: 110,
                damping: 0.09
            },
            stabilization: {
                enabled: true,
                iterations: 120,
                updateInterval: 25
            }
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

    // Lock physics after stabilization to freeze the layout
    network.once("stabilizationFinished", function() {
        network.setOptions({ physics: false });
        console.log(`[OK] Subgraph stabilized and physics locked.`);
    });
}

// 3. Walkthrough Execution
function startWalkthrough(startNodeId) {
    let url = "/api/walkthrough";
    if (startNodeId) {
        url += `?start_id=${encodeURIComponent(startNodeId)}`;
    } else {
        clearNavStack();
        visibleNodeIds.clear();
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
    
    // Render focal graph
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
                        <span class="call-relation">${targetNode.name}</span>
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

    nodeExplanationEl.classList.add("hidden");
    explanationLoader.classList.remove("hidden");
    
    fetch(`/api/node/explain?node_id=${encodeURIComponent(nodeId)}`)
        .then(res => res.json())
        .then(data => {
            nodeExplanationEl.textContent = data.explanation || "No explanation generated.";
            nodeExplanationEl.classList.remove("hidden");
        })
        .catch(err => {
            nodeExplanationEl.textContent = "Failed to communicate with local Ollama server.";
            nodeExplanationEl.classList.remove("hidden");
        })
        .finally(() => {
            explanationLoader.classList.add("hidden");
        });
}

function selectLibraryNode(libNodeId) {
    const node = nodesTable[libNodeId];
    if (!node) return;

    noSelectionMessage.classList.add("hidden");
    nodeDetailsContainer.classList.remove("hidden");

    nodeTypeBadge.textContent = "EXTERNAL LIBRARY";
    nodeTypeBadge.className = "badge type-badge library-mode";
    nodeNameEl.textContent = node.name;
    nodeFileLink.textContent = "External Reference";
    nodeFileLink.removeAttribute("href");
    nodeLinesEl.textContent = "";
    nodeScopeEl.textContent = "Scope: Python Standard Library or Pip Module";
    nodeCodeBlock.textContent = "# Source code unavailable for third-party libraries";
    outboundCallsList.innerHTML = `<li class="empty-list-text" style="font-size:12px; color:var(--text-muted); font-style:italic;">None</li>`;
    
    nodeExplanationEl.classList.add("hidden");
    explanationLoader.classList.remove("hidden");
    
    fetch(`/api/node/explain?node_id=${encodeURIComponent(libNodeId)}`)
        .then(res => res.json())
        .then(data => {
            nodeExplanationEl.textContent = data.explanation || `External library entity "${node.name}".`;
            nodeExplanationEl.classList.remove("hidden");
        })
        .catch(err => {
            nodeExplanationEl.textContent = `External call to library entity "${node.name}".`;
            nodeExplanationEl.classList.remove("hidden");
        })
        .finally(() => {
            explanationLoader.classList.add("hidden");
        });

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
