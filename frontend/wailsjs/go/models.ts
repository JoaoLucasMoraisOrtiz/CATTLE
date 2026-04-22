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
	    }
	}
	export class Project {
	    name: string;
	    path: string;
	    kb_docs?: string[];
	    agents: Agent[];
	
	    static createFrom(source: any = {}) {
	        return new Project(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.kb_docs = source["kb_docs"];
	        this.agents = this.convertValues(source["agents"], Agent);
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

