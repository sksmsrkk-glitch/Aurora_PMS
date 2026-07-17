/** PostgreSQL positional-parameter lexer shared by runtime and behavior tests. */
export function compilePostgresParameters(query, valueCount) {
  let state = "normal";
  let output = "";
  let parameter = 0;
  let dollarTag = "";

  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    const next = query[index + 1];

    if (state === "line-comment") {
      output += character;
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      output += character;
      if (character === "*" && next === "/") {
        output += next;
        index += 1;
        state = "normal";
      }
      continue;
    }
    if (state === "single-quote") {
      output += character;
      if (character === "'" && next === "'") {
        output += next;
        index += 1;
      } else if (character === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      output += character;
      if (character === '"' && next === '"') {
        output += next;
        index += 1;
      } else if (character === '"') state = "normal";
      continue;
    }
    if (state === "dollar-quote") {
      if (query.startsWith(dollarTag, index)) {
        output += dollarTag;
        index += dollarTag.length - 1;
        state = "normal";
      } else output += character;
      continue;
    }

    if (character === "-" && next === "-") {
      output += character + next;
      index += 1;
      state = "line-comment";
      continue;
    }
    if (character === "/" && next === "*") {
      output += character + next;
      index += 1;
      state = "block-comment";
      continue;
    }
    if (character === "'") {
      output += character;
      state = "single-quote";
      continue;
    }
    if (character === '"') {
      output += character;
      state = "double-quote";
      continue;
    }
    if (character === "$") {
      const match = query.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u);
      if (match) {
        dollarTag = match[0];
        output += dollarTag;
        index += dollarTag.length - 1;
        state = "dollar-quote";
        continue;
      }
    }
    if (character === "?") {
      parameter += 1;
      output += `$${parameter}`;
      continue;
    }
    output += character;
  }

  if (["single-quote", "double-quote", "block-comment", "dollar-quote"].includes(state)) {
    throw new Error("Unterminated SQL literal or comment");
  }
  if (parameter !== valueCount) {
    throw new Error(`SQL parameter mismatch: expected ${parameter}, received ${valueCount}`);
  }
  return output.trim().replace(/;\s*$/u, "");
}
