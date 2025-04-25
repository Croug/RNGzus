window = typeof window === "undefined" ? null : window;
function randRange(min, max) {
    const range = max - min;
    const rnd = crypto.getRandomValues(new Uint32Array(1))[0] / 0xffffffff;
    return dbg(Math.floor(min + rnd * range));
}

function sample(input) {
    return input[randRange(0, input.length)];
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

function dbg(arg) {
    if (!window?.DEBUG || process.env.DEBUG !== "true") return arg;
    const callerInfo = getCallerInfo();
    const prefix =
        "DBG: " +
        (callerInfo
            ? `${callerInfo.file}:${callerInfo.line}:${callerInfo.char} - `
            : "");
    if (typeof arg === "object") {
        console.log(prefix, JSON.stringify(arg, null, 2));
    } else {
        console.log(prefix, arg);
    }
    return arg;
}

const alphabet = [
	...Array.from({length:26}, (_,i) => String.fromCharCode(97 + i)),
	...Array.from({length:26}, (_,i) => String.fromCharCode(65 + i))
]

class CompileCache {
    constructor() {
        this.functionCache = new Map();
        this.stringCache = new Map();
        this.namePattern = []
    }

    getNextFuncName() {
        let carry = true;
        for (let i = alphabet.length - 1; carry && i >= 0; i--) {
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
        return this.namePattern.map(x => alphabet[x]).join('')
    }

    getOrInsertFunction(func) {
        if (!this.functionCache.has(func.name)) {
            this.functionCache.set(func.name, {
                name: func.name,
                nameMinfied: this.getNextFuncName(),
                body: this.getFunctionExpression(func),
                hits: 0,
                __cached_func: true,
            })
        }

        return this.functionCache.get(func.name)
    }

    registerFunctionHit(func) {
        this.getOrInsertFunction(func).hits++
    }

    getFunctionParts(func) {
        const funcStr = func.toString();
        const match = funcStr.match(/^((function \s*([\w\-]*)\s*)?(?<params>\(.*\))\s*(=>)?|(?<paramsUnwrapped>.*)=>)((?<body>[\s\S]+))/i);

        return {
            params: match.groups.params.trim() || `(${paramsUnwrapped.trim()})`,
            body: match.groups.body.trim(),
        }
    }

    getFunctionInvocation(func, ...args) {
        const funcInfo = this.functionCache.get(func)
        if (!funcInfo) {
            return `(${this.getFunctionExpression(func)})(${args.join(",")})`
        }
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

    generate() {
        throw new Error("Must override generate() method in subclass");
    }

    compileSingle() {
        throw new Error ("Must override compileSingle() method in subclass")
    }

    process() {
        return Array(this.count)
            .fill(0)
            .map((_) => this.generate())
            .join("");
    }

    compile() {
        return this.count > 1 ? 
            `Array(${this.count}).fill(0).map(_=>${this.compileSingle()}).join('')` :
            this.compileSingle()
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

    compileSingle() {
        return `"${this.literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
}

class GroupNode extends TreeNode {
    constructor(children, sequential = false) {
        super();
        this.children = children;
        this.sequential = sequential;
    }

    generate() {
        return dbg(
            this.sequential
                ? this.children.map((token) => token.process()).join("")
                : sample(this.children).process(),
        );
    }

    compileSingle() {
        const arrStr = `[${this.children.map(x=>x.compile()).join(',')}]`
        return this.sequential ? `${arrStr}.join('')` : `sample(${arrStr})`
    }
}

class RootNode extends GroupNode {
    constructor(children) {
        super(children, true);
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

    compileSingle() {
        return `sample("${this.sampleSet.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`
    }
}

class AnyNode extends TreeNode {
    generate() {
        return String.fromCharCode(randRange(32, 127));
    }

    compileSingle() {
        return `String.fromCharCode(randRange(32, 172))`
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

    compileSingle() {
        return `randRange(0, 10).toString()`
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

    compileSingle() {
        return `randRange(${this.start},${this.end}).toString()`
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

    compileSingle() {
        const r = super.compileSingle()
        return `String.fromCharCode(${r.substring(0, r.length - 11)})`
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
        const compiled = tree.compile()
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

const readline = window ? null : require("readline");
function nodeRepl(rl) {
    rl = rl ?? readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    })

    rl.question(">>> ", (input) => {
        const [output, result] = parseRepl(input);
        (result ? console.log : console.error)(output);
        nodeRepl(rl);
    })
}

function browserRepl() {
    window.tinyConsole.onLine((input) => {
        const [output, _] = parseRepl(input);
        window.tinyConsole.write(output);
    })
    window.tinyConsole.suggestions = {
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
    window.tinyConsole.renderSuggestions()

}

function repl() {
    if (window?.tinyConsole) {
        browserRepl();
    } else {
        nodeRepl();
    }
}

// const output = parse('aA#@$')
// const output = parse('a"hello \\"world\\""A')
// const output = parse('[abc]<3>')
// const output = parse(':1-5::a-c:')
// const output = parse('(aaa)<2>{A#$}')

// console.log(output);

// for (let i = 0; i < 10; i++) {
//     console.log(i + 1, output.process());
// }

repl()
