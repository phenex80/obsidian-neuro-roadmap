import type { SourceScopeMode, SourceScopeRule } from '../types';
import {
  normalizePropertyKey,
  normalizeSemanticValue,
  readValueStrings,
} from './SemanticMapping';

export interface CompiledSourceScopeRule {
  readonly propertyKey: string;
  readonly acceptedValues: ReadonlySet<string>;
}

export interface SourceScopeConfig {
  readonly mode: SourceScopeMode;
  readonly rules: readonly CompiledSourceScopeRule[];
}

export function compileSourceScope(
  mode: SourceScopeMode,
  rules: readonly SourceScopeRule[],
): SourceScopeConfig {
  return {
    mode,
    rules: rules
      .map(compileSourceScopeRule)
      .filter((rule): rule is CompiledSourceScopeRule => rule !== null),
  };
}

export function isFrontmatterInSourceScope(
  frontmatter: Readonly<Record<string, unknown>> | null,
  scope: SourceScopeConfig,
): boolean {
  if (scope.mode === 'all') {
    return true;
  }
  if (frontmatter === null || scope.rules.length === 0) {
    return false;
  }

  const valuesByKey = new Map(
    Object.entries(frontmatter).map(([key, value]) => [normalizePropertyKey(key), value]),
  );
  return scope.rules.some((rule) => {
    const value = valuesByKey.get(rule.propertyKey);
    return readValueStrings(value).some((candidate) =>
      rule.acceptedValues.has(normalizeSemanticValue(candidate)),
    );
  });
}

export function hasValidSourceScopeRules(rules: readonly SourceScopeRule[]): boolean {
  return compileSourceScope('rules', rules).rules.length > 0;
}

function compileSourceScopeRule(rule: SourceScopeRule): CompiledSourceScopeRule | null {
  const propertyKey = normalizePropertyKey(rule.property);
  const acceptedValues = new Set(
    rule.acceptedValues
      .split(/[,\n]/u)
      .map(normalizeSemanticValue)
      .filter((value) => value.length > 0),
  );
  return propertyKey.length === 0 || acceptedValues.size === 0
    ? null
    : { propertyKey, acceptedValues };
}
