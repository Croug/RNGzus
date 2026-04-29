import * as acorn from "./acorn.mjs";
import * as periscopic from "./periscopic.mjs"

const windowObj = typeof window === "undefined" ? null : window;
function randRange(min, max) {
    const range = max - min;
    const rnd = crypto.getRandomValues(new Uint32Array(1))[0] / 0xffffffff;
    return (Math.floor(min + rnd * range));
}

/**
 * 
 * @template T
 * @param {T[]} input 
 * @returns {T}
 */
function sample(input) {
    return input[randRange(0, input.length)];
}

function getRawJson(ast) {
    return JSON.stringify(ast, (k,v) => {
        return k === "loc" || k === "start" || k === "end" ? undefined : v
    })
}

Array.prototype.iter = function() {
    return Iterator.from(this);
}

const IteratorPrototype =
  Object.getPrototypeOf(
    Object.getPrototypeOf(
      [][Symbol.iterator]()
    )
  );

IteratorPrototype.enumerate = function* () {
    let o,i = 0;
    while (!(o = this.next()).done) {
        yield [i++, o.value];
    }
}

IteratorPrototype.interleave = function* (other) {
    const iters = [this, other];
    let o,c = 1;
    while (!(o = iters[c ^= 1].next()).done) {
        yield o.value;
    }
}

IteratorPrototype.log = function *() {
    let o;
    while (!(o = this.next()).done) {
        console.log(o.value);
        yield o.value;
    }
}

IteratorPrototype.tagAll = function (tag) {
    return this.map(x=>[tag, x])
}

IteratorPrototype.groupBy = function(keyFn) {
    return Object.groupBy(this, keyFn);
}

IteratorPrototype.join = function (separator="") {
    let o,acc=this.next().value?.toString()||"";

    while (!(o = this.next()).done) {
        acc += separator + o.value?.toString()
    }

    return acc;
}

function walkTree(node, callback, filter=()=>true, maxDepth = Infinity, depth = 0, ...path) {
    depth = depth + 1;
    Object.entries(node).forEach(([key, value]) => {
        if (Array.isArray(value)) {
            value.values().enumerate().filter(([i,v])=>filter(v, node.type, [...path, key, i])).forEach(([i, x])=>callback(x, depth, node.type, [...path, key, i]));

            if (depth < maxDepth)
                value.forEach((node, index) => walkTree(node, callback, filter, maxDepth, depth, ...path, key, index));
        } else if (typeof value === "object" && value !== null) {
            if (filter(value, node.type, [...path, key]))
                callback(value, depth, node.type, [...path, key]);

            if (depth < maxDepth)
                walkTree(value, callback, filter, maxDepth, depth, ...path, key);
        }
    })
}

let fs;
function getSource() {
    if (windowObj) {
        const req = new XMLHttpRequest()
        req.open("GET", import.meta.url, false)
        req.send()
        return req.responseText
    }

    return fs.readFileSync(import.meta.url.replace("file:///", ""), "utf-8");
}

function getCallerInfo() {
    const err = new Error();
    const stackLines = err.stack.split("\n");
    const callerLine = stackLines[3];
    const match =
        callerLine.match(/at (.+) \((.+):(\d+):(\d+)\)/) ||
        callerLine.match(/at (.+):(\d+):(\d+)/);
    if (match) {
        if (match.length === 5) {
            const [_, functionName, file, line, char] = match;
            return {
                functionName,
                file,
                line: parseInt(line, 10),
                char: parseInt(char, 10),
            };
        } else if (match.length === 4) {
            const [_, file, line, char] = match;
            return { file, line: parseInt(line, 10), char: parseInt(char, 10) };
        }
    }
    return null;
}

const dbgFilter = new RegExp(windowObj?.DEBUG_FILTER || globalThis?.process?.env?.DEBUG_FILTER || undefined, "i");

function dbg(arg, source="") {
    if (!(windowObj?.DEBUG || globalThis?.process?.env?.DEBUG)) return arg;
    if (!dbgFilter.test(source)) return arg;
    const callerInfo = getCallerInfo();
    const prefix =
        `DBG: ${
            source ? `[${source}] ` : ""
        }${
        (callerInfo
            ? `${callerInfo.file}:${callerInfo.line}:${callerInfo.char} - `
            : "")
        }`;
    if (typeof arg === "object") {
        console.log(prefix, JSON.stringify(arg, null, 2));
    } else {
        console.log(prefix, arg);
    }
    return arg;
}

function setDebugFilter(filter) {
    if (windowObj) {
        windowObj.DEBUG = true;
        windowObj.DEBUG_FILTER = filter;
    } else {
        process.env.DEBUG = true;
        process.env.DEBUG_FILTER = filter;
    }
}

const alphabet = [
	...Array.from({length:26}, (_,i) => String.fromCharCode(97 + i)),
	...Array.from({length:26}, (_,i) => String.fromCharCode(65 + i))
]

class CompileCache {
    constructor() {
        this.functionCache = new Map();
        this.variableCache = new Set();
        this.variableMap = new Map();
        this.stringMap = new Map();
        this.namePattern = []
        this.source = getSource();
        this.sourceAst = acorn.parse(this.source, {
            ecmaVersion: "latest",
            sourceType: "module",
        })
        this.sourceAnalysis = periscopic.analyze(this.sourceAst);
        this.sourceScope = this.sourceAnalysis.map.get(this.sourceAst);
    }

    getNextIdentifier() {
        let carry = true;
        for (let i = this.namePattern.length - 1; carry && i >= 0; i--) {
            carry = false;
            this.namePattern[i]++;
            if (this.namePattern[i] >= alphabet.length) {
                this.namePattern[i] = 0;
                carry = true;
            }
        }
        if (carry) {
            this.namePattern.unshift(0);
        }
        const ret = this.namePattern.map(x => alphabet[x]).join('')
        return ret
    }

    getOrInsertFunction(func) {
        if (!this.functionCache.has(func.name)) {
            this.insertFunction(func)
        }

        return this.functionCache.get(func.name)
    }

    hasIdentifier(name) {
        return this.variableMap.has(name) || this.functionCache.has(name) || this.stringMap.has(name);
    }

    registerVariableHit(name, hits=1) {
        this.variableMap.get(name).hits += hits;
    }

    registerHit(item, hits=1) {
        const name = typeof item === "function" ? this.getOrInsertFunction(item).name : item;
        (this.functionCache.get(name) || this.variableMap.get(name) || this.stringMap.get(name)).hits += hits;
        return name;
    }

    parseFunction(func) {
        let ast = acorn.parse(func.toString(), {
            ecmaVersion: "latest",
            sourceType: "script",
        });
        ast = ast.body[0].expression || ast.body[0];
        const json = getRawJson(ast);
        walkTree(this.sourceAst, x=>ast=x, x=>getRawJson(x) === json);

        return ast;
    }

    isGlobal(name) {
        try {
            return globalThis.hasOwnProperty(name) || globalThis === eval(name);
        } catch {
            return false;
        }
    }

    analyzeFunctionAst(funcAst) {
        const {map, declarations, globals} = periscopic.analyze(funcAst);
        const dependencyNames = new Set(globals.values().map(x=>x.name).filter(x=>!this.isGlobal(x)))
        const dependencies = {}

        walkTree(
            funcAst,
            x=>(dependencies[x.name] || (dependencies[x.name] = [])).push(x),
            x=>x.type === "Identifier" && dependencyNames.has(x.name)
        )

        return {
            map,
            declarations,
            dependencies,
        }
    }

    insertFunction(func, name, collectDependencies=true) {
        name ||= func.name;
        let funcAst = typeof func === "function" ? this.parseFunction(func) : func;
        let funcAnalysis = this.analyzeFunctionAst(funcAst);
        let functionParts = this.getFunctionParts(funcAst, funcAnalysis);
        this.functionCache.set(name, {
            name,
            nameMinified: this.getNextIdentifier(),
            params: functionParts.params,
            body: functionParts.body,
            hits: 0,
            dependencies: funcAnalysis.dependencies,
            block: funcAst.body.type === "BlockStatement",
            __cached_func: true,
        })
        if (collectDependencies) {
            this.collectDependencies(funcAst, funcAnalysis);
        }
    }

    walkIdentifiers(ast, visit=console.log, enter=()=>{}, exit=()=>{}) {
        switch (ast.type) {
            case "ObjectPattern":
                enter('{');
                ast.properties.forEach(x=>this.walkIdentifiers(x, visit, enter, exit));
                exit('}');
                break;
            case "ArrayPattern":
                enter('[');
                ast.elements.forEach(x=>this.walkIdentifiers(x, visit, enter, exit));
                exit(']');
                break;
            case "Property":
                enter(`${ast.key.name}:`);
                this.walkIdentifiers(ast.value, visit, enter, exit);
                exit('');
                break;
            case "Identifier":
                visit(ast.name);
                break;
            default:
                throw new Error(`Unsupported AST type: ${ast.type}`);
        }
    }

    insertVariable(ast) {
        for (const declaration of ast.declarations) {
            const init = declaration.init;
            const v = {
                declarations: "",
                init: init ? this.source.slice(init.start, init.end) : null,
                kind: ast.kind,
                identifiers: {},
                hits: 0,
            }
            this.walkIdentifiers(declaration.id, x=> {
                const ident = this.getNextIdentifier();
                v.identifiers[x] = ident;
                v.declarations += v.identifiers[x] + ",";
                this.variableMap.set(x, v);
            },x=>v.declarations+=x, x=> v.declarations+=x)
            if (v.declarations.endsWith(',')) {
                v.declarations = v.declarations.slice(0, -1);
            }
            this.variableCache.add(v);
        }
    }

    insertAst(ast) {
        switch (ast.type) {
            case "FunctionDeclaration":
            case "FunctionExpression":
                this.insertFunction(ast, ast.id.name);
                break;
            case "VariableDeclaration":
                this.insertVariable(ast);
                break;
            default:
                throw new Error(`Unsupported AST type: ${ast.type}`);
        }
    }

    collectDependencies(funcAst, funcAnalysis) {
        const { map } = this.sourceAnalysis;
        const funcScope = map.get(funcAst);
        const { dependencies } = funcAnalysis;
        Object.keys(dependencies)
            .filter(x=>funcScope.has(x) || this.hasIdentifier(x))
            .forEach(x => {
                if (!this.hasIdentifier(x)) {
                    const value = funcScope.find_owner(x).declarations.get(x);
                    this.insertAst(value);
                }
                this.registerHit(x, dependencies[x].length);
            })
    }

    interpolateDependencies(funcAst, {dependencies}) {
        const bodyStart = funcAst.body.start;
        const bodyEnd = funcAst.body.end;
        const flatDependencies = [...Object.entries(dependencies).iter().flatMap(([dep, instances], i)=>instances.iter().tagAll(dep))]
        flatDependencies.sort((a, b) => a[1].start - b[1].start);
        const body = []
        const interpolated = []

        let lastEnd = bodyStart;
        flatDependencies.forEach(([dep, instance]) => {
            body.push(this.source.slice(lastEnd, dbg(instance, 'interp.instance').start));
            interpolated.push(dep);
            lastEnd = instance.end;
        });
        body.push(this.source.slice(lastEnd, bodyEnd));

        return [body, ...interpolated]
    }

    internString(input) {
        const strNode = typeof input === "string" ? {value: input} : input;
        if (!this.stringMap.has(strNode.value)) {
            const name = this.getNextIdentifier();
            const v = {
                declarations: name,
                init: `"${strNode.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
                kind: "const",
                identifiers: {'*': name},
                hits: 0,
                string: true,
            }
            this.stringMap.set(strNode.value, v);
            this.variableCache.add(v);
        }

        return this.stringMap.get(strNode.value).declarations;
    }

    getStringsInterned(funcAst, {dependencies}) {
        walkTree(funcAst, x=> {
            this.internString(x);
            (dependencies[x.value] || (dependencies[x.value] = [])).push(x)
        }, x=>x.type === "Literal" && typeof x.value === "string");
    }

    getFunctionParts(funcAst, funcAnalysis) {
        const params = funcAst.params?.length ? (()=>{
            const startIdx = funcAst.params[0].start;
            const endIdx = funcAst.params[funcAst.params.length - 1].end;
            return `(${this.source.slice(startIdx, endIdx).trim()})`
        })() : "()";

        this.getStringsInterned(funcAst, funcAnalysis);
        const body = this.interpolateDependencies(funcAst, funcAnalysis);

        return {
            params,
            body,
        }
    }

    resolveFunctionBody(funcInfo) {
        const [sparse, ...deps] = funcInfo.body;
        return sparse.iter().interleave(deps.iter().map(this.expandDependency.bind(this))).join("");
    }

    getDeclarationBlock() {
        const allVars = this.variableCache.values().filter(x=> x.string ? x.hits > 1 : x.hits).groupBy(x=>x.kind);
        const varStr = Object.keys(allVars).iter().map(ty=>`${ty} ${
            allVars[ty].iter().map(x=>`${x.declarations}${x.init ? `=${x.init}` : ""}`).join(",")
        };`).join("")

        const funcStr = this.functionCache.values().filter(x=>x.hits > 1).map(f => f.block ? `function ${f.nameMinified}${f.params}${this.resolveFunctionBody(f)}` : 
            `const ${f.nameMinified}=${f.params}=>${this.resolveFunctionBody(f)};`
        ).join("")

        return `${varStr}${funcStr}`
    }

    expandDependency(name) {
        if (this.functionCache.has(name))
            return this.getFunctionInvocation(name);
        if (this.variableMap.has(name)) 
            return this.variableMap.get(name).identifiers[name];
        if (this.stringMap.has(name)) {
            const str = this.stringMap.get(name);
            return str.hits < 2 ? str.init : this.stringMap.get(name).declarations;
        }

        return name;
    }

    getFunctionInvocation(func) {
        func = typeof func === "function" ? func.name : func;
        const funcInfo = this.functionCache.get(func)
        if (funcInfo.hits < 2) {
            const body = this.resolveFunctionBody(funcInfo);
            return `(${funcInfo.params}=>${body})`
        } else {
            return funcInfo.nameMinified
        }
    }

    anon(body) {
        // working here <<<
    }

    processSingle(item) {
        if (item === null || item === undefined) {
            return new PlaceholderLiteral(String(item));
        }

        if (item instanceof Placeholder) {
            return item;
        }

        if (typeof item === "function") {
            return new PlaceholderSingle(this.registerHit(item));
        }

        if(typeof item === 'string') {
            this.internString(item);
            return new PlaceholderSingle(this.registerHit(item));
        }

        if(typeof (item[Symbol.iterator]) === 'function') {
            const iter = Iterator.from(item).map(x => {
                return this.processSingle(x);
            });

            return new PlaceholderIterable(iter);
        }

        return new PlaceholderLiteral(String(item));
    }

    process(strings, ...values) {
        const valueIter = values.iter().map(v => this.processSingle(v));
        return new PlaceholderTemplate(strings.iter(), valueIter);
    }

    rawString(str) {
        return new PlaceholderLiteral(str);
    }
}

class Placeholder {
    collect() {}
    expand(cache) {
        throw new Error("Must override expand() method in subclass");
    }
}

class PlaceholderLiteral extends Placeholder {
    constructor(value) {
        super();
        this.value = value;
    }
    expand(_) {
        return this.value;
    }
}

/***
 * @typedef {Object} PlaceholderTemplate
 * @property {Iterator<string>} strings - An iterator over the literal string segments of the template
 * @property {Iterator<Placeholder>} placeholders - An iterator over the evaluated placeholder values of the template
 */
class PlaceholderTemplate extends Placeholder {
    constructor(strings, placeholders) {
        super();
        this.strings = strings;
        this.placeholders = placeholders;
    }
    collect() {
        this.placeholderCache = [...this.placeholders.map(p => {
            p.collect();
            return p;
        })];
    }
    expand(cache) {
        if (!this.placeholderCache)
            this.collect();

        return this.strings.interleave(this.placeholderCache.iter().map(p=>p.expand(cache))).join("");
    }
}

/***
 * @typedef {Object} PlaceholderIterable
 * @property {Iterable<Placeholder>} iterator - An iterable of placeholders to be expanded and concatenated
 */
class PlaceholderIterable extends Placeholder {
    constructor(iterator) {
        super();
        this.iterator = iterator;
    }
    collect() {
        this.iteratorCache = [...this.iterator.map(p => {
            p.collect();
            return p;
        })];
    }
    expand(cache) {
        if (!this.iteratorCache)
            this.collect();
        return this.iteratorCache.map(v => v.expand(cache)).join(",");
    }
}

/***
 * @typedef {Object} PlaceholderSingle
 * @property {string} name - The name of the placeholder, used for cache lookups
 */
class PlaceholderSingle extends Placeholder {
    constructor(name) {
        super();
        this.name = name;
    }
    expand(cache) {
        return cache.expandDependency(this.name);
    }
}

class ParseError extends Error {
    constructor(message, index) {
        super(message);
        this.index = index;
    }
}

class TreeNode {
    constructor() {
        this.count = 1;
    }

    setCount(count) {
        this.count = count;
    }

    /**
     * Evaluate AST node once and return result
     * 
     * @abstract
     * @returns {string}
     */
    generate() {
        throw new Error("Must override generate() method in subclass");
    }


    /**
     * Transpile AST node to javascript that returns single result
     * 
     * @abstract
     * @param {CompileCache} cache
     * @returns {Placeholder}
     */
    compileSingle(cache) {
        throw new Error ("Must override `compileSingle` method in subclass")
    }

    /**
     * Evaluate the AST node {count} times and return result
     * 
     * @returns {string}
     */
    evaluate() {
        return Array(this.count)
            .fill(0)
            .map((_) => this.generate())
            .join("");
    }

    /**
     * Transpile AST to javascript called {count} times
     * 
     * @param {CompileCache} cache 
     * @returns {Placeholder}
     */
    compile(cache) {
        return this.count > 1 ? 
            cache.process`Array(${this.count}).fill(0).map(_=>${this.compileSingle(cache)}).join('')` :
            this.compileSingle(cache)
    }
}

class LiteralNode extends TreeNode {
    constructor(literal) {
        super();
        this.literal = literal;
    }

    generate() {
        return dbg(this.literal);
    }

    compileSingle(cache) {
        // return `"${this.literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        return cache.process`${this.literal}`
    }
}

class GroupNode extends TreeNode {
    constructor(children, sequential = false) {
        super();
        /**
         * @type {TreeNode[]}
         */
        this.children = children;
        this.sequential = sequential;
    }

    generate() {
        return dbg(
            this.sequential
                ? this.children.map((token) => token.evaluate()).join("")
                : sample(this.children).evaluate(),
        );
    }

    compileSingle(cache) {
        // const arrStr = `[${this.children.map(x=>x.compile(cache)).join(',')}]`
        // return this.sequential ? `${arrStr}.join('')` : `sample(${arrStr})`

        const arrCache = this.children.map(x=>x.compile(cache))

        return this.sequential ?
            cache.process`[${arrCache}].join('')` :
            cache.process`${sample}(${arrCache})`
    }
}

class RootNode extends GroupNode {
    constructor(children) {
        super(children, true);
    }
    toString() {
        const cache = new CompileCache();
        const body = this.compile(cache).expand(cache);
        return cache.getDeclarationBlock() + body;
    }
}

class SampleNode extends TreeNode {
    constructor(sampleSet) {
        super();
        this.sampleSet = sampleSet;
    }

    generate() {
        return dbg(sample(this.sampleSet));
    }

    compileSingle(cache) {
        // return `sample("${this.sampleSet.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`
        return cache.process`${sample}(${this.sampleSet})`
    }
}

class AnyNode extends TreeNode {
    generate() {
        return String.fromCharCode(randRange(32, 127));
    }

    compileSingle(cache) {
        // return `String.fromCharCode(randRange(32, 172))`
        return cache.process`String.fromCharCode(${randRange}(32, 172))`
    }
}

class AlphaNode extends SampleNode {
    constructor(uppercase = false) {
        super(
            uppercase
                ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                : "abcdefghijklmnopqrstuvwxyz",
        );
    }
}

class NumericNode extends TreeNode {
    generate() {
        return dbg(randRange(0, 10).toString());
    }

    compileSingle(cache) {
        // return `randRange(0, 10).toString()`
        return cache.process`${randRange}(0, 10).toString()`
    }
}

class SymbolNode extends SampleNode {
    constructor() {
        super("!@#$%^&*()_+-=[]{}|;:'\",.<>?");
    }
}

class BasicSymbolNode extends SampleNode {
    constructor() {
        super("!@#$%^&*?");
    }
}

class RangeNode extends TreeNode {
    constructor(start, end) {
        super();
        this.start = start;
        this.end = end + 1;
    }

    generate() {
        return dbg(randRange(this.start, this.end).toString());
    }

    compileSingle(cache) {
        // return `randRange(${this.start},${this.end}).toString()`
        return cache.process`${randRange}(${this.start},${this.end}).toString()`
    }
}

class AsciiRangeNode extends RangeNode {
    constructor(start, end) {
        const startCode = start.charCodeAt(0);
        const endCode = end.charCodeAt(0);
        super(startCode, endCode);
    }

    generate() {
        const code = parseInt(super.generate());
        return String.fromCharCode(code);
    }

    compileSingle(cache) {
        // return `String.fromCharCode(${r.substring(0, r.length - 11)})`
        return cache.process`String.fromCharCode(${randRange}(${this.start},${this.end}))`
    }
}

class ParseContext {
    constructor(endToken, nodeType, ...instantiationArgs) {
        this.endToken = endToken;
        this.nodeType = nodeType;
        this.instantiationArgs = instantiationArgs;
        this.children = [];
    }

    finalize() {
        return new this.nodeType(this.children, ...this.instantiationArgs);
    }
}

class Parser {
    parse(str) {
        this.defaultContext = new ParseContext(undefined, GroupNode, true);
        this.input = str;
        this.children = [];
        this.current = 0;
        this.contextStack = [this.defaultContext];
        this.defaultContext.children = this.children;

        while (this.current < this.input.length) {
            this.parseToken();
        }

        if (this.contextStack.length > 1) {
            throw new ParseError(`Expected '${this.currentContext.endToken}' but got EOF`, this.current)
        }

        return new RootNode(this.children);
    }

    get currentContext() {
        return this.contextStack[this.contextStack.length - 1];
    }

    get currentNodeSet() {
        return this.currentContext.children;
    }

    get lastNode() {
        return this.currentNodeSet[this.currentNodeSet.length - 1];
    }

    parseToken() {
        const head = this.current
        let token = this.advance();
        switch (token) {
            case this.currentContext.endToken:
                return this.push(this.popContext());
            case ".": // any character
                return this.push(new AnyNode());
            case "a": // lowercase alpha
                return this.push(new AlphaNode());
            case "A": // uppercase alpha
                return this.push(new AlphaNode(true));
            case "#": // numeric
                return this.push(new NumericNode());
            case "@": // extended symbol set
                return this.push(new SymbolNode());
            case "$": // basic symbol set
                return this.push(new BasicSymbolNode());
            case '"': // literal
                const [literal, _1] = dbg(this.consumeUntil('"'));
                return this.push(new LiteralNode(literal));
            case "[": // sample set
                const [sampleSet, _2] = dbg(this.consumeUntil("]"));
                return this.push(new SampleNode(sampleSet));
            case "<": // repeat modifier
                const [numStr, _3] = dbg(this.consumeUntil(">"));
                const num = parseInt(numStr);
                if (isNaN(num)) {
                    throw new ParseError(
                        'Repeat modifier must be a number', head
                    );
                }
                this.lastNode.setCount(num);
                return null;
            case ":": // range
                let rangeStr, endToken;
                this.pushContext(undefined, GroupNode);
                do {
                    [rangeStr, endToken] = dbg(this.consumeUntil(":", ";"));
                    const [start, end] = rangeStr.split("-");
                    if (isNaN(start)) {
                        this.push(new AsciiRangeNode(start, end));
                    } else {
                        const startNum = parseInt(start);
                        const endNum = parseInt(end);
                        this.push(new RangeNode(startNum, endNum));
                    }
                } while (endToken !== ";")
                const groupNode = this.popContext();
                if (groupNode.children.length > 1) {
                    this.push(groupNode);
                } else {
                    this.push(groupNode.children[0]);
                }
                break;
            case "(": // start group
                return this.pushContext(")", GroupNode, true);
            case "{": // start group sample
                return this.pushContext("}", GroupNode, false);
        }
    }

    push(token) {
        this.currentNodeSet.push(token);
        return token;
    }

    pushContext(endToken, nodeType, ...instantiationArgs) {
        const context = new ParseContext(
            endToken,
            nodeType,
            ...instantiationArgs,
        );
        this.contextStack.push(context);
        return context;
    }

    popContext() {
        return this.contextStack.pop().finalize();
    }

    consume(predicate, expectedToken) {
        let token = this.advance();
        if (token === "\\") {
            token = this.advance();
        }
        if (!predicate(token)) {
            throw new ParseError(
                `Expected '${expectedToken}' but got ${token}`, this.current - 1
            );
        }
        return token;
    }

    consumeUntil(...endTokens) {
        let output = "";

        let t = this.advance();
        for (; !endTokens.includes(t); t = this.advance()) {
            if (t === undefined) {
                const verbage = endTokens.length > 1 ? ` one of (${endTokens.map(t => `'${t}'`).join(", ")})` : ` '${endTokens[0]}'`
                throw new ParseError(`Expected ${verbage} but got EOF`, this.current - 1);
            }
            if (t === "\\") {
                output += this.advance();
                continue;
            }
            output += t;
        }

        return [output, t];
    }

    advance() {
        return this.input[this.current++];
    }

    peek(count = 0) {
        return this.input[this.current + count];
    }
}

function parseRepl(str) {
    try {
        const tree = new Parser().parse(str);
        const compiled = tree.toString()
        let output;
        try {
            output = eval(compiled);
        } catch (ex) {
            output = ex.message
        }
        return [compiled + '\n' + output, true];
    } catch(ex) {
        const arrow = ex instanceof ParseError ? " ".repeat(ex.index + 4) + "^\n" : ""
        return [`${arrow}${ex.message}`, false]
    }
}

function nodeRepl(rl) {
    rl.question(">>> ", (input) => {
        const [output, result] = parseRepl(input);
        (result ? console.log : console.error)(output);
        nodeRepl(rl);
    })
}

function browserRepl() {
    windowObj.tinyConsole.onLine((input) => {
        const [output, _] = parseRepl(input);
        windowObj.tinyConsole.write(output);
    })
    windowObj.tinyConsole.suggestions = {
        "Any": ".",
        "Lowercase": "a",
        "Uppercase": "A",
        "Numeric": "#",
        "Basic Symbol": "$",
        "Any Symbol": "@",
        "Literal": '"|"',
        "Sample Set": "[|]",
        "Range": ":|x|-x;",
        "Group": "(|)",
        "Sample Children": "{|}",
        "Repeat": "<|n|>",
    }
    windowObj.tinyConsole.renderSuggestions()
}

(async ()=>{
    if (windowObj?.tinyConsole) {
        browserRepl();
    } else {
        fs = await import("node:fs");
        const readline = await import("node:readline");
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        })
        nodeRepl(rl);
    }
})()
