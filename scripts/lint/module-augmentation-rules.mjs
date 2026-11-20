import ts from "typescript";

function vendorInterface(context, node) {
  if (
    node?.type !== "TSInterfaceDeclaration" ||
    node.parent.type !== "TSModuleBlock" ||
    node.parent.parent.type !== "TSModuleDeclaration" ||
    node.parent.parent.id.type !== "Literal"
  ) {
    return undefined;
  }

  const { program, esTreeNodeToTSNodeMap } = context.sourceCode.parserServices;
  const declaration = esTreeNodeToTSNodeMap?.get(node);
  if (!program || !declaration || !ts.isInterfaceDeclaration(declaration)) {
    return undefined;
  }
  if (!ts.isExternalModule(declaration.getSourceFile())) return undefined;

  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return undefined;

  return checker.getMergedSymbol(symbol).declarations?.find((original) => {
    return (
      ts.isInterfaceDeclaration(original) &&
      program.isSourceFileFromExternalLibrary(original.getSourceFile())
    );
  });
}

function isRequiredTypeParameter(context, node) {
  if (node?.parent?.type !== "TSTypeParameter") return false;
  const parameters = node.parent.parent;
  if (parameters.type !== "TSTypeParameterDeclaration") return false;
  const original = vendorInterface(context, parameters.parent);
  const index = parameters.params.indexOf(node.parent);
  return index >= 0 && index < (original?.typeParameters?.length ?? 0);
}

/** Preserve TypeScript ESLint rules outside merges with a dependency's interface. */
export function withModuleAugmentationRules(plugin) {
  const consistentTypeDefinitions = plugin.rules["consistent-type-definitions"];
  const noUnusedVars = plugin.rules["no-unused-vars"];
  return {
    ...plugin,
    rules: {
      ...plugin.rules,
      "consistent-type-definitions": {
        ...consistentTypeDefinitions,
        create(context) {
          const listeners = consistentTypeDefinitions.create(context);
          const checkInterface = listeners.TSInterfaceDeclaration;
          if (!checkInterface) return listeners;
          return {
            ...listeners,
            TSInterfaceDeclaration(node) {
              if (!vendorInterface(context, node)) checkInterface(node);
            },
          };
        },
      },
      "no-unused-vars": {
        ...noUnusedVars,
        create(context) {
          // Its reports for unused type parameters carry the identifier node.
          const augmentationContext = Object.create(context, {
            report: {
              value(descriptor) {
                if (!isRequiredTypeParameter(context, descriptor.node)) {
                  context.report(descriptor);
                }
              },
            },
          });
          return noUnusedVars.create(augmentationContext);
        },
      },
    },
  };
}
