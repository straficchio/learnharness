/**
 * A deliberately small, dependency-free math expression compiler for chart
 * functions. It accepts numbers, the variable x, the constants pi/e, the
 * operators + - * / ^, parentheses, and a fixed function whitelist.
 *
 * There is no eval, no Function constructor, no property access, no
 * assignment and no implicit multiplication: anything outside that grammar
 * is a parse error. This replaced expr-eval after its critical audit
 * advisories (code execution via toJSFunction, prototype pollution); a chart
 * expression is untrusted model input, so a tiny closed evaluator is safer
 * than a general expression library.
 */

export class ExpressionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExpressionError";
	}
}

type Token =
	| { kind: "number"; value: number; position: number }
	| { kind: "name"; value: string; position: number }
	| { kind: "operator"; value: "+" | "-" | "*" | "/" | "^" | "(" | ")" | ","; position: number };

type Ast =
	| { kind: "number"; value: number }
	| { kind: "constant"; value: number }
	| { kind: "x" }
	| { kind: "unary"; operator: "+" | "-"; operand: Ast }
	| { kind: "binary"; operator: "+" | "-" | "*" | "/" | "^"; left: Ast; right: Ast }
	| { kind: "call"; name: string; args: Ast[] };

const CONSTANTS: Record<string, number> = {
	pi: Math.PI,
	e: Math.E,
};

const UNARY_FUNCTIONS: Record<string, (value: number) => number> = {
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	asin: Math.asin,
	acos: Math.acos,
	atan: Math.atan,
	sinh: Math.sinh,
	cosh: Math.cosh,
	tanh: Math.tanh,
	exp: Math.exp,
	log: Math.log,
	ln: Math.log,
	log10: Math.log10,
	log2: Math.log2,
	sqrt: Math.sqrt,
	cbrt: Math.cbrt,
	abs: Math.abs,
	floor: Math.floor,
	ceil: Math.ceil,
	round: Math.round,
	trunc: Math.trunc,
	sign: Math.sign,
};

const BINARY_FUNCTIONS: Record<string, (left: number, right: number) => number> = {
	pow: Math.pow,
	atan2: Math.atan2,
};

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let position = 0;
	while (position < source.length) {
		const character = source[position]!;
		if (/\s/.test(character)) {
			position += 1;
			continue;
		}
		if (/[0-9.]/.test(character)) {
			const match = /^(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/.exec(source.slice(position));
			if (!match) throw new ExpressionError(`unexpected "${character}" at position ${position + 1}.`);
			const value = Number(match[0]);
			if (!Number.isFinite(value)) throw new ExpressionError(`number "${match[0]}" is out of range.`);
			tokens.push({ kind: "number", value, position });
			position += match[0].length;
			continue;
		}
		if (/[a-zA-Z]/.test(character)) {
			const match = /^[a-zA-Z][a-zA-Z0-9]*/.exec(source.slice(position));
			const value = match?.[0] ?? "";
			tokens.push({ kind: "name", value, position });
			position += value.length;
			continue;
		}
		if (character === "+" || character === "-" || character === "*" || character === "/" || character === "^" || character === "(" || character === ")" || character === ",") {
			tokens.push({ kind: "operator", value: character, position });
			position += 1;
			continue;
		}
		throw new ExpressionError(`unexpected "${character}" at position ${position + 1}.`);
	}
	return tokens;
}

class Parser {
	private index = 0;
	private readonly tokens: Token[];

	constructor(source: string) {
		this.tokens = tokenize(source);
	}

	parse(): Ast {
		if (this.tokens.length === 0) throw new ExpressionError("expression is empty.");
		const expression = this.additive();
		const leftover = this.peek();
		if (leftover) throw new ExpressionError(`unexpected token at position ${leftover.position + 1}.`);
		return expression;
	}

	private peek(): Token | undefined {
		return this.tokens[this.index];
	}

	private take(): Token {
		const token = this.tokens[this.index];
		if (!token) throw new ExpressionError("expression ended unexpectedly.");
		this.index += 1;
		return token;
	}

	private matchOperator(value: string): boolean {
		const token = this.peek();
		if (token?.kind === "operator" && token.value === value) {
			this.index += 1;
			return true;
		}
		return false;
	}

	private additive(): Ast {
		let left = this.multiplicative();
		for (;;) {
			if (this.matchOperator("+")) left = { kind: "binary", operator: "+", left, right: this.multiplicative() };
			else if (this.matchOperator("-")) left = { kind: "binary", operator: "-", left, right: this.multiplicative() };
			else return left;
		}
	}

	private multiplicative(): Ast {
		let left = this.unary();
		for (;;) {
			if (this.matchOperator("*")) left = { kind: "binary", operator: "*", left, right: this.unary() };
			else if (this.matchOperator("/")) left = { kind: "binary", operator: "/", left, right: this.unary() };
			else return left;
		}
	}

	private unary(): Ast {
		if (this.matchOperator("+")) return { kind: "unary", operator: "+", operand: this.unary() };
		if (this.matchOperator("-")) return { kind: "unary", operator: "-", operand: this.unary() };
		return this.power();
	}

	private power(): Ast {
		const base = this.primary();
		if (this.matchOperator("^")) {
			// Right-associative, and the exponent may carry its own sign.
			return { kind: "binary", operator: "^", left: base, right: this.unary() };
		}
		return base;
	}

	private primary(): Ast {
		const token = this.take();
		if (token.kind === "number") return { kind: "number", value: token.value };
		if (token.kind === "operator" && token.value === "(") {
			const expression = this.additive();
			if (!this.matchOperator(")")) throw new ExpressionError("missing closing parenthesis.");
			return expression;
		}
		if (token.kind === "name") {
			const name = token.value;
			if (this.matchOperator("(")) {
				const args: Ast[] = [];
				if (!this.matchOperator(")")) {
					for (;;) {
						args.push(this.additive());
						if (this.matchOperator(")")) break;
						if (!this.matchOperator(",")) throw new ExpressionError(`expected "," or ")" in ${name}().`);
					}
				}
				this.validateCall(name, args.length);
				return { kind: "call", name, args };
			}
			if (name === "x") return { kind: "x" };
			const constant = Object.hasOwn(CONSTANTS, name) ? CONSTANTS[name] : undefined;
			if (constant !== undefined) return { kind: "constant", value: constant };
			if (Object.hasOwn(UNARY_FUNCTIONS, name) || Object.hasOwn(BINARY_FUNCTIONS, name)) {
				throw new ExpressionError(`${name} is a function; write ${name}(...).`);
			}
			throw new ExpressionError(`unknown variable "${name}" (only x is allowed).`);
		}
		throw new ExpressionError("expected a number, x, a function or a parenthesis.");
	}

	private validateCall(name: string, count: number): void {
		if (Object.hasOwn(UNARY_FUNCTIONS, name)) {
			if (count !== 1) throw new ExpressionError(`${name}() takes exactly one argument.`);
			return;
		}
		if (Object.hasOwn(BINARY_FUNCTIONS, name)) {
			if (count !== 2) throw new ExpressionError(`${name}() takes exactly two arguments.`);
			return;
		}
		if (name === "min" || name === "max") {
			if (count < 1) throw new ExpressionError(`${name}() takes at least one argument.`);
			return;
		}
		throw new ExpressionError(`unknown function "${name}".`);
	}
}

function evaluate(ast: Ast, x: number): number {
	switch (ast.kind) {
		case "number":
		case "constant":
			return ast.value;
		case "x":
			return x;
		case "unary":
			return ast.operator === "-" ? -evaluate(ast.operand, x) : evaluate(ast.operand, x);
		case "binary": {
			const left = evaluate(ast.left, x);
			const right = evaluate(ast.right, x);
			switch (ast.operator) {
				case "+": return left + right;
				case "-": return left - right;
				case "*": return left * right;
				case "/": return left / right;
				case "^": return left ** right;
				default: throw new ExpressionError("unknown operator.");
			}
		}
		case "call": {
			const args = ast.args.map((argument) => evaluate(argument, x));
			if (ast.name === "min") return Math.min(...args);
			if (ast.name === "max") return Math.max(...args);
			const unaryFunction = Object.hasOwn(UNARY_FUNCTIONS, ast.name) ? UNARY_FUNCTIONS[ast.name] : undefined;
			if (unaryFunction) return unaryFunction(args[0]!);
			const binaryFunction = Object.hasOwn(BINARY_FUNCTIONS, ast.name) ? BINARY_FUNCTIONS[ast.name] : undefined;
			if (binaryFunction) return binaryFunction(args[0]!, args[1]!);
			throw new ExpressionError(`unknown function "${ast.name}".`);
		}
		default: throw new ExpressionError("invalid expression.");
	}
}

/** Compile a chart expression onto a callable f(x). The returned function is
 *  pure and needs no scope object; evaluation never touches JavaScript eval. */
export function compileExpression(source: string): (x: number) => number {
	const ast = new Parser(source).parse();
	return (x: number) => evaluate(ast, x);
}
