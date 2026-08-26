import { describe, expect, it } from "vitest";
import { parsePyStub } from "./py-stub-parser.js";

describe("py-stub-parser", () => {
  it("parses single-line and multi-line function declarations into compact signatures", () => {
    const stub = `
def load(stream: _ReadStream, Loader: type[_Loader | _CLoader]) -> _YAMLObject: ...
def scan(stream, Loader: type[_Loader | _CLoader] = ...): ...
async def fetch(url: str, timeout: float = 10.0) -> Response: ...
def emit(
    events,
    stream: _WriteStream[_YAMLObject] | None = None,
    Dumper=...,
    canonical: bool | None = None,
): ...
`;
    const result = parsePyStub(stub);

    expect(result.exports).toEqual([
      {
        name: "load",
        kind: "function",
        signature: "load(stream: _ReadStream, Loader: type[_Loader | _CLoader]) -> _YAMLObject",
      },
      {
        name: "scan",
        kind: "function",
        signature: "scan(stream, Loader: type[_Loader | _CLoader] = ...)",
      },
      {
        name: "fetch",
        kind: "function",
        signature: "fetch(url: str, timeout: float = 10.0) -> Response",
      },
      {
        name: "emit",
        kind: "function",
        signature: "emit(events, stream: _WriteStream[_YAMLObject] | None = None, Dumper=..., canonical: bool | None = None)",
      },
    ]);
  });

  it("handles @overload and other decorators preceding function definitions", () => {
    const stub = `
@overload
def serialize(node: Node, stream: Stream) -> None: ...
@overload
def serialize(node: Node, stream: None = None) -> str: ...
@classmethod
def from_yaml(cls, loader, node): ...
`;
    const result = parsePyStub(stub);

    expect(result.exports).toContainEqual({
      name: "serialize",
      kind: "function",
      signature: "serialize(node: Node, stream: Stream) -> None",
    });
    expect(result.exports).toContainEqual({
      name: "from_yaml",
      kind: "function",
      signature: "from_yaml(cls, loader, node)",
    });
  });

  it("extracts class declarations and skips indented class body methods as module exports", () => {
    const stub = `
class YAMLError(Exception): ...

class YAMLObject(metaclass=YAMLObjectMetaclass):
    __slots__ = ()
    yaml_loader: Incomplete
    yaml_dumper: Incomplete
    @classmethod
    def from_yaml(cls, loader, node): ...
    def to_yaml(cls, dumper, data): ...

def top_level_fn() -> None: ...
`;
    const result = parsePyStub(stub);

    expect(result.exports).toEqual([
      { name: "YAMLError", kind: "class", signature: null },
      { name: "YAMLObject", kind: "class", signature: null },
      { name: "top_level_fn", kind: "function", signature: "top_level_fn() -> None" },
    ]);
  });

  it("extracts module-level constants and dunder variables", () => {
    const stub = `
__version__: Final[str]
__with_libyaml__: Final[bool]
__author__ = "Author Name"
TIMEOUT: int = 30
`;
    const result = parsePyStub(stub);

    expect(result.exports).toEqual([
      { name: "__version__", kind: "const", signature: "__version__: Final[str]" },
      { name: "__with_libyaml__", kind: "const", signature: "__with_libyaml__: Final[bool]" },
      { name: "__author__", kind: "const", signature: '__author__ = "Author Name"' },
      { name: "TIMEOUT", kind: "const", signature: "TIMEOUT: int = 30" },
    ]);
  });

  it("extracts PEP 695 type statements and TypeAlias annotations", () => {
    const stub = `
type StringOrInt = str | int
UserCallback: TypeAlias = Callable[[str], None]
`;
    const result = parsePyStub(stub);

    expect(result.exports).toEqual([
      { name: "StringOrInt", kind: "type", signature: null },
      { name: "UserCallback", kind: "type", signature: null },
    ]);
  });

  it("parses single-line and parenthesised multi-line PEP 484 explicit re-exports", () => {
    const stub = `
from . import __version__ as version_mod, packages as packages, utils as utils
from .api import (
    delete as delete,
    get as get,
    post as post,
    request as request,
)
from .models import PreparedRequest as PreparedRequest, Response as Response
from .cyaml import *
`;
    const result = parsePyStub(stub);

    expect(result.reExports).toEqual([
      {
        module: "./",
        names: [
          { from: "__version__", as: "version_mod" },
          { from: "packages", as: "packages" },
          { from: "utils", as: "utils" },
        ],
      },
      {
        module: "./api",
        names: [
          { from: "delete", as: "delete" },
          { from: "get", as: "get" },
          { from: "post", as: "post" },
          { from: "request", as: "request" },
        ],
      },
      {
        module: "./models",
        names: [
          { from: "PreparedRequest", as: "PreparedRequest" },
          { from: "Response", as: "Response" },
        ],
      },
      {
        module: "./cyaml",
      },
    ]);
  });

  it("filters out private names with leading underscores unless dunder or explicitly re-exported", () => {
    const stub = `
_T = TypeVar("_T")
_InternalClass = ...
_private_var: int = 1

def _private_func(): ...
def public_func(): ...

class _PrivateClass: ...
class PublicClass: ...

from .internal import _helper as _helper
`;
    const result = parsePyStub(stub);

    expect(result.exports).toEqual([
      { name: "public_func", kind: "function", signature: "public_func()" },
      { name: "PublicClass", kind: "class", signature: null },
    ]);
    expect(result.reExports).toEqual([
      {
        module: "./internal",
        names: [{ from: "_helper", as: "_helper" }],
      },
    ]);
  });

  it("handles inline comments without breaking strings containing hash symbols", () => {
    const stub = `
from . import resolver as resolver  # Help mypy a bit; this is implied by loader and dumper
COLOR_HEX: Final[str] = "#FF0000"  # Hex color code
def test_fn() -> None: ...  # trailing comment
`;
    const result = parsePyStub(stub);

    expect(result.reExports).toEqual([
      {
        module: "./",
        names: [{ from: "resolver", as: "resolver" }],
      },
    ]);
    expect(result.exports).toContainEqual({
      name: "COLOR_HEX",
      kind: "const",
      signature: 'COLOR_HEX: Final[str] = "#FF0000"',
    });
    expect(result.exports).toContainEqual({
      name: "test_fn",
      kind: "function",
      signature: "test_fn() -> None",
    });
  });

  it("extracts public API names declared in __all__ from plain parenthesised imports (numpy-like)", () => {
    const stub = `
__all__ = [
    "array",
    "zeros",
    "arange",
    "asarray",
    "ndarray",
]

from numpy._core.multiarray import (
    array,
    empty_like,
    zeros,
    arange,
    asarray,
)

class ndarray: ...
`;
    const result = parsePyStub(stub);

    // Public names in __all__ must be emitted
    expect(result.exports).toContainEqual({
      name: "array",
      kind: "function",
      signature: null,
    });
    expect(result.exports).toContainEqual({
      name: "zeros",
      kind: "function",
      signature: null,
    });
    expect(result.exports).toContainEqual({
      name: "arange",
      kind: "function",
      signature: null,
    });
    expect(result.exports).toContainEqual({
      name: "asarray",
      kind: "function",
      signature: null,
    });
    expect(result.exports).toContainEqual({
      name: "ndarray",
      kind: "class",
      signature: null,
    });

    // Plain import NOT in __all__ must NOT be emitted as an export
    expect(result.exports.find((e) => e.name === "empty_like")).toBeUndefined();

    // Notes must indicate unresolvable signatures for names defined in external modules
    expect(result.notes).toBeDefined();
    expect(result.notes?.some((n) => n.includes("array") && n.includes("numpy._core.multiarray"))).toBe(true);
    expect(result.notes?.some((n) => n.includes("zeros") && n.includes("numpy._core.multiarray"))).toBe(true);
  });

  it("does not emit plain imports as exports when __all__ is absent", () => {
    const stub = `
from numpy._core.multiarray import (
    array,
    zeros,
)

def direct_func() -> None: ...
`;
    const result = parsePyStub(stub);

    // When __all__ is absent, plain imports are internal and must NOT be emitted
    expect(result.exports).toEqual([
      {
        name: "direct_func",
        kind: "function",
        signature: "direct_func() -> None",
      },
    ]);
    expect(result.exports.find((e) => e.name === "array")).toBeUndefined();
    expect(result.exports.find((e) => e.name === "zeros")).toBeUndefined();
    expect(result.notes).toBeUndefined();
  });

  it("emits exports for __all__ names that are neither imported nor defined in the file", () => {
    const stub = `
__all__ = ["declared_only_fn", "DeclaredClass", "DECLARED_CONST"]
`;
    const result = parsePyStub(stub);

    expect(result.exports).toEqual([
      {
        name: "declared_only_fn",
        kind: "function",
        signature: null,
      },
      {
        name: "DeclaredClass",
        kind: "class",
        signature: null,
      },
      {
        name: "DECLARED_CONST",
        kind: "const",
        signature: null,
      },
    ]);

    expect(result.notes?.length).toBe(3);
    expect(result.notes?.every((n) => n.includes("not defined or imported"))).toBe(true);
  });

  it("supports typed, annotated, tuple, and augmented __all__ definitions", () => {
    const stub = `
__all__: Final[list[str]] = [
    'first_fn',
    'SecondClass',
]
__all__ += ('third_fn',)
__all__.extend(["fourth_fn"])

from .helpers import first_fn, SecondClass, third_fn, fourth_fn
`;
    const result = parsePyStub(stub);

    expect(result.exports).toContainEqual({ name: "first_fn", kind: "function", signature: null });
    expect(result.exports).toContainEqual({ name: "SecondClass", kind: "class", signature: null });
    expect(result.exports).toContainEqual({ name: "third_fn", kind: "function", signature: null });
    expect(result.exports).toContainEqual({ name: "fourth_fn", kind: "function", signature: null });
  });
});

