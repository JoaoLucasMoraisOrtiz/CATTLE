/* ReDo! — Global state */

let agents = [];
let projectsList = [];
let flows = [];
let headersList = [];
let currentFlowId = null;
let editingId = null;
let editingHeaderId = null;
let selectedHeaderId = null;
let editor = null; // Drawflow instance
let drawflowReady = false;
let startNodeId = '';
let sessionOpen = false;
let chatTarget = null;
let eventSource = null;
let chatHistory = [];
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
