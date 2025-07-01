import { parse } from "@babel/parser"

export function walkies(source: string) {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx", "decorators-legacy", "classProperties"],
  })
  const results: string[] = []
  for (const node of ast.program.body) {
    switch (node.type) {
      case "ImportDeclaration": {
        const val = node.source.value
        if (typeof val == "string") {
          results.push(val)
        }
        break
      }
      case "ExportNamedDeclaration": {
        const val = node.source
        if (typeof val == "string") {
          results.push(val)
        }
      }
      case "ExportAllDeclaration": {
        const val = node.source
        if (typeof val == "string") {
          results.push(val)
        }
        break
      }
    }
  }
  return results
}

// export default function walkImports(
//   source: string,
//   callback: (
//     value: string,
//     nodePath: NodePath<
//       ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration
//     >,
//   ) => void,
// ) {
//   const ast = parse(source, {
//     sourceType: "module",
//     plugins: ["typescript", "jsx", "decorators-legacy", "classProperties"],
//   })

//   traverse(ast, {
//     ImportDeclaration(path) {
//       const val = path.node.source.value
//       callback(val, path)
//     },
//     ExportNamedDeclaration(path) {
//       if (path.node.source) {
//         const val = path.node.source.value
//         callback(val, path)
//       }
//     },
//     ExportAllDeclaration(path) {
//       const val = path.node.source.value
//       callback(val, path)
//     },
//   })
// }

// export function walkImportsAndRequires<T>(
//   source: string,
//   callback: (
//     value: string,
//     nodePath: NodePath<
//       | ImportDeclaration
//       | ExportNamedDeclaration
//       | ExportAllDeclaration
//       | CallExpression
//     >,
//   ) => T,
// ): T[] {
//   const ast = parse(source, {
//     sourceType: "module",
//     plugins: ["typescript", "jsx", "decorators-legacy", "classProperties"],
//   })

//   const results: T[] = []

//   traverse(ast, {
//     ImportDeclaration(path) {
//       const val = path.node.source.value
//       results.push(callback(val, path))
//     },
//     ExportNamedDeclaration(path) {
//       if (path.node.source) {
//         const val = path.node.source.value
//         results.push(callback(val, path))
//       }
//     },
//     ExportAllDeclaration(path) {
//       const val = path.node.source.value
//       results.push(callback(val, path))
//     },
//     CallExpression(path) {
//       if (
//         path.node.callee.type === "Identifier" &&
//         path.node.callee.name === "require" &&
//         path.node.arguments.length > 0 &&
//         path.node.arguments[0].type === "StringLiteral"
//       ) {
//         const val = path.node.arguments[0].value
//         results.push(callback(val, path))
//       }
//     },
//   })
//   return results
// }
