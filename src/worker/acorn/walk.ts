import {
  CallExpression,
  ExportAllDeclaration,
  ExportNamedDeclaration,
  ImportDeclaration,
  Parser,
  Program,
} from "acorn"
import { tsPlugin } from "@sveltejs/acorn-typescript"
import { walk } from "estree-walker"

export function parse(code: string) {
  return Parser.extend(tsPlugin()).parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  })
}

export function walkImportsAndRequires<T>(
  program: Program,
  callback: (
    value: string,
    node:
      | ImportDeclaration
      | ExportNamedDeclaration
      | ExportAllDeclaration
      | CallExpression,
  ) => T,
): T[] {
  const results: T[] = []
  walk(
    // @ts-expect-error these are the same
    program,
    {
      enter(node, parent) {
        switch (node.type) {
          case "ImportDeclaration": {
            const val = node.source.value
            if (typeof val == "string") {
              results.push(callback(val, node as ImportDeclaration))
            }
            break
          }
          case "ExportNamedDeclaration": {
            const val = node.source
            if (typeof val == "string") {
              results.push(callback(val, node as ExportNamedDeclaration))
            }
          }
          case "ExportAllDeclaration": {
            const val = node.source
            if (typeof val == "string") {
              results.push(callback(val, node as ExportAllDeclaration))
            }
            break
          }
          case "CallExpression": {
            if (
              node.callee.type === "Identifier" &&
              node.callee.name === "require" &&
              node.arguments.length > 0 &&
              node.arguments[0].type === "Literal"
            ) {
              const val = node.arguments[0].value as string
              results.push(callback(val, node as CallExpression))
            }
          }
        }
      },
    },
  )
  return results
}
