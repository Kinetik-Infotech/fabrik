// What every tool of fabrik's connector is made of: the request's context, a tool's shape, and the calls that run fabrik's
// database functions as the signed-in person. index.ts and cards.ts both build their tools from it, and index.ts gives it
// on to anything that imports the connector.
import { z } from "npm:zod@4.3.6";

/** The connector's version, which the server gives Claude and each card's shell gives its host. */
export const VERSION = "0.1.0";

/** The fabrik schema's client, as the signed-in person. */
// deno-lint-ignore no-explicit-any
export type Fabrik = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }> };
/** A request to the project's own services, such as Storage or a hosted function, at a path such as /storage/v1/...,
 * sent with the person's own token. */
export type Project = (path: string, init?: RequestInit) => Promise<Response>;
/** What each tool's run gets for one request. person is the signed-in account's id, from the request's verified token. */
export type Ctx = { fabrik: Fabrik; project: Project; person?: string };
/** A tool's result, as MCP gives it: text for the model, and the data as structuredContent. */
export type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown>; isError?: boolean };
/** One tool of the connector. meta is the tool's _meta, such as the card it shows, or that only a card calls it. */
// deno-lint-ignore no-explicit-any
export type Tool<S extends z.ZodObject<any> = z.ZodObject<any>> = {
  name: string;
  description: string;
  input: S;
  meta?: Record<string, unknown>;
  run: (ctx: Ctx, args: z.infer<S>) => Promise<Result>;
};
/** Declares a tool, keeping its run's arguments typed by its input. The cast widens Tool<S> to Tool, since run takes
 * its arguments contravariantly and TOOLS holds tools of different inputs; register() parses each call against the
 * tool's own input before run sees it. */
// deno-lint-ignore no-explicit-any
export const tool = <S extends z.ZodObject<any>>(t: Tool<S>): Tool => t as unknown as Tool;

/** A refusal, in the words given. */
export const refused = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });
/** Data, as JSON text for the model and as structuredContent. */
export const answer = (data: unknown): Result => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : { result: data },
});
/** Calls one fabrik database function as the person, and gives its answer, or its refusal as the tool's error. */
export async function call(ctx: Ctx, fn: string, args: Record<string, unknown> = {}): Promise<Result> {
  const { data, error } = await ctx.fabrik.rpc(fn, args);
  if (error) return refused(error.message);
  // fabrik answers a change it refused for want of permission, rather than raising it.
  if (data && typeof data === "object" && data.refused === true) return refused(String(data.problem ?? "fabrik refused the change."));
  return answer(data);
}

/** The scope a person names by its id, its code or its name, among those list_scopes gives them, as { scope_id, code,
 * name }: a scope's files are in the Storage bucket named by its code. As fabrik's own named_scope, it tries the id,
 * then the code, then the name, each in any case, and refuses a name more than one scope has, naming each, since a
 * scope's name need not be unique. */
export async function scopeOf(ctx: Ctx, scope: string): Promise<{ scope_id: string; code: string; name: string } | string> {
  const all = await allScopes(ctx);
  return typeof all === "string" ? all : scopeIn(all, scope);
}

/** A scope as fabrik_get_scopes gives it. */
export type ScopeItem = { scope_id: string; code: string; display_name: string; [k: string]: unknown };

/** Every scope the person may see, every page of fabrik_get_scopes, or fabrik's refusal. */
export async function allScopes(ctx: Ctx): Promise<ScopeItem[] | string> {
  const all: ScopeItem[] = [];
  let cursor: string | null = null;
  do {
    const { data, error } = await ctx.fabrik.rpc("fabrik_get_scopes", { p_cursor: cursor, p_limit: 100 });
    if (error) return error.message;
    all.push(...(data?.items ?? []));
    cursor = data?.next_cursor ?? null;
  } while (cursor);
  return all;
}

/** The scope named among the scopes given, as scopeOf finds it, or why none is. */
export function scopeIn(all: ScopeItem[], scope: string): { scope_id: string; code: string; name: string } | string {
  const named = scope.trim().toLowerCase();
  for (const key of ["scope_id", "code", "display_name"]) {
    const hits = all.filter((x) => String(x[key] ?? "").toLowerCase() === named);
    if (hits.length === 1) return { scope_id: hits[0].scope_id, code: hits[0].code, name: hits[0].display_name };
    if (hits.length > 1) {
      const each = [...hits].sort((a, b) => String(a.code).localeCompare(String(b.code)))
        .map((x) => `${x.display_name} (code ${x.code}, id ${x.scope_id})`).join("; ");
      return `More than one scope has the name "${scope}": ${each}. Name the scope by its scope_id.`;
    }
  }
  return `Scope unavailable: no scope you can see has the id, code or name "${scope}". list_scopes gives them.`;
}
