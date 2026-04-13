/* ReDo! — Global state with CustomEvent notifications */

const State = {
  _data: {
    agents: [],
    projectsList: [],
    flows: [],
    headersList: [],
    currentFlowId: null,
    editingId: null,
    editingHeaderId: null,
    selectedHeaderId: null,
    sessionOpen: false,
    chatTarget: null,
    chatHistory: [],
    runTabs: [], // [{id, projectId, flowId, ...}]
    activeTabId: null,
    startNodeId: '',
  },
  get(key) { return this._data[key]; },
  set(key, value) {
    this._data[key] = value;
    document.dispatchEvent(new CustomEvent('state:' + key, { detail: value }));
  },
};

// Backward-compatible globals — read/write proxied to State._data
let agents = []; let projectsList = []; let flows = []; let headersList = [];
let currentFlowId = null; let editingId = null; let editingHeaderId = null;
let selectedHeaderId = null; let sessionOpen = false; let chatTarget = null;
let chatHistory = []; let startNodeId = '';

let editor = null;
let drawflowReady = false;
let eventSource = null;
let nodeHeaderIds = {};
let flowDefaultHeaderIds = [];
const agentStatus = {};
const returnEdges = new Set();
const DEFAULT_HEADER_IDS = ['default-protocol', 'default-wrapper'];

const MCP_PRESETS = {
  browser:   { command: 'uv', args: ['--directory', '../browser-mcp', 'run', 'python', 'server.py'] },
  dataflow:  { command: 'uv', args: ['--directory', '../dataflow-mcp', 'run', 'python', 'server.py'] },
  knowledge: { command: 'uv', args: ['--directory', '../knowledge-mcp', 'run', 'python', 'server.py'] },
};
