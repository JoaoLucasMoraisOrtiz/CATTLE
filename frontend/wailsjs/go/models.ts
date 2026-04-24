export namespace codeview {
	
	export class Branch {
	    name: string;
	    current: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Branch(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.current = source["current"];
	    }
	}
	export class Commit {
	    hash: string;
	    message: string;
	    body?: string;
	    author: string;
	    time: string;
	    timestamp: number;
	    files: number;
	    repo?: string;
	    local?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Commit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hash = source["hash"];
	        this.message = source["message"];
	        this.body = source["body"];
	        this.author = source["author"];
	        this.time = source["time"];
	        this.timestamp = source["timestamp"];
	        this.files = source["files"];
	        this.repo = source["repo"];
	        this.local = source["local"];
	    }
	}
	export class Edge {
	    from: string;
	    to: string;
	    type: string;
	
	    static createFrom(source: any = {}) {
	        return new Edge(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.from = source["from"];
	        this.to = source["to"];
	        this.type = source["type"];
	    }
	}
	export class FileDiff {
	    path: string;
	    status: string;
	    additions: number;
	    deletions: number;
	
	    static createFrom(source: any = {}) {
	        return new FileDiff(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.status = source["status"];
	        this.additions = source["additions"];
	        this.deletions = source["deletions"];
	    }
	}
	export class Symbol {
	    name: string;
	    kind: string;
	    file: string;
	    start_line: number;
	    end_line: number;
	    calls: string[];
	    status?: string;
	
	    static createFrom(source: any = {}) {
	        return new Symbol(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.kind = source["kind"];
	        this.file = source["file"];
	        this.start_line = source["start_line"];
	        this.end_line = source["end_line"];
	        this.calls = source["calls"];
	        this.status = source["status"];
	    }
	}
	export class SymbolGraph {
	    symbols: Symbol[];
	    edges: Edge[];
	
	    static createFrom(source: any = {}) {
	        return new SymbolGraph(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.symbols = this.convertValues(source["symbols"], Symbol);
	        this.edges = this.convertValues(source["edges"], Edge);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace domain {
	
	export class Agent {
	    name: string;
	    command: string;
	    color: string;
	    cli_type: string;
	    mcps?: Record<string, any>;
	    work_dir?: string;
	
	    static createFrom(source: any = {}) {
	        return new Agent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.command = source["command"];
	        this.color = source["color"];
	        this.cli_type = source["cli_type"];
	        this.mcps = source["mcps"];
	        this.work_dir = source["work_dir"];
	    }
	}
	export class Message {
	    ID: number;
	    SessionID: string;
	    Project: string;
	    Agent: string;
	    Role: string;
	    Content: string;
	    Embedding: number[];
	    CreatedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new Message(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.SessionID = source["SessionID"];
	        this.Project = source["Project"];
	        this.Agent = source["Agent"];
	        this.Role = source["Role"];
	        this.Content = source["Content"];
	        this.Embedding = source["Embedding"];
	        this.CreatedAt = source["CreatedAt"];
	    }
	}
	export class ProjectConfig {
	    language?: string;
	    framework?: string;
	    entry_file?: string;
	    test_cmd?: string;
	    build_cmd?: string;
	
	    static createFrom(source: any = {}) {
	        return new ProjectConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.language = source["language"];
	        this.framework = source["framework"];
	        this.entry_file = source["entry_file"];
	        this.test_cmd = source["test_cmd"];
	        this.build_cmd = source["build_cmd"];
	    }
	}
	export class Project {
	    name: string;
	    path: string;
	    kb_docs?: string[];
	    agents: Agent[];
	    code_config?: ProjectConfig;
	
	    static createFrom(source: any = {}) {
	        return new Project(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.kb_docs = source["kb_docs"];
	        this.agents = this.convertValues(source["agents"], Agent);
	        this.code_config = this.convertValues(source["code_config"], ProjectConfig);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace main {
	
	export class ChunkHit {
	    source: string;
	    content: string;
	    type: string;
	
	    static createFrom(source: any = {}) {
	        return new ChunkHit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source = source["source"];
	        this.content = source["content"];
	        this.type = source["type"];
	    }
	}

}

