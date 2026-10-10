// 分类与供应商路由 —— 对应原 Go 版 internal/handlers/category.go 与 supplier.go。

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SupplierInput } from "../db/catalog";
import { isErrorCode } from "../lib/errors";
import { setError } from "../lib/flash";
import { parsePage, parsePerPage } from "../lib/pagination";
import { roleCanWrite, roleLabel } from "../types";
import {
  categoryFormView,
  categoryListView,
  supplierDetailView,
  supplierFormView,
  supplierListView,
} from "../views/catalog";
import {
  businessErrorMessage,
  currentQueryWithoutPage,
  formValues,
  notFoundPage,
  redirectWith,
  render,
  serverError,
} from "./helpers";

export const catalogRoutes = new Hono<AppEnv>();

type Values = Record<string, string>;
type Errors = Record<string, string>;

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 读取路径参数 {id}；非法（非纯数字 / 非正数）返回 null。 */
function pathId(c: Context<AppEnv>): number | null {
  const raw = c.req.param("id") ?? "";
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * 检查写权限 —— 对应 Go 版 handler.canWrite。
 *
 * 有权限返回 null，否则返回一个已构造好的响应：未登录跳登录页，
 * 角色只读则给出中文提示并回到首页。调用方拿到非 null 直接 return 即可。
 */
function requireWrite(c: Context<AppEnv>): Response | null {
  const user = c.get("user");
  if (!user) return c.redirect("/login", 303);
  if (!roleCanWrite(user.role)) {
    setError(c, `当前角色为「${roleLabel(user.role)}」，没有修改数据的权限`);
    return c.redirect("/", 303);
  }
  return null;
}

/** 从表单装配供应商输入（字段名与原版一致，读取一律走 helpers）。 */
async function supplierInput(c: Context<AppEnv>): Promise<{ input: SupplierInput; values: Values }> {
  const values = await formValues(c, [
    "name",
    "contact_person",
    "phone",
    "email",
    "address",
    "note",
  ]);
  return {
    values,
    input: {
      name: values.name,
      contactPerson: values.contact_person,
      phone: values.phone,
      email: values.email,
      address: values.address,
      note: values.note,
    },
  };
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

catalogRoutes.get("/categories", async (c) => {
  const store = c.get("store");
  const search = (c.req.query("q") ?? "").trim();
  const page = parsePage(c.req.query("page"));
  const perPage = parsePerPage(c.req.query("per_page"));

  try {
    const { categories, pagination } = await store.listCategories({ search, page, perPage });
    return render(
      c,
      200,
      "分类管理",
      "categories",
      { categories, pagination, search, query: currentQueryWithoutPage(c) },
      categoryListView,
    );
  } catch (err) {
    return serverError(c, err);
  }
});

// ⚠️ /categories/new 必须注册在 /categories/:id 之前，否则会被后者吞掉。
catalogRoutes.get("/categories/new", async (c) => {
  const denied = requireWrite(c);
  if (denied) return denied;

  return render(
    c,
    200,
    "新建分类",
    "categories",
    { category: null, values: {}, errors: {}, isEdit: false },
    categoryFormView,
  );
});

catalogRoutes.post("/categories", async (c) => {
  const denied = requireWrite(c);
  if (denied) return denied;

  const store = c.get("store");
  const values = await formValues(c, ["name", "description"]);

  try {
    await store.createCategory(values.name, values.description);
  } catch (err) {
    const errors: Errors = { form: businessErrorMessage(err) };
    // 重名 / 名称不合法都归到 name 字段上标红，用户一眼能看出改哪里。
    if (isErrorCode(err, "conflict") || isErrorCode(err, "invalidInput")) {
      errors.name = businessErrorMessage(err);
      delete errors.form;
    }
    return render(
      c,
      422,
      "新建分类",
      "categories",
      { category: null, values, errors, isEdit: false },
      categoryFormView,
    );
  }

  return redirectWith(c, "/categories", "success", `分类「${values.name}」创建成功`);
});

catalogRoutes.get("/categories/:id/edit", async (c) => {
  const denied = requireWrite(c);
  if (denied) return denied;

  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  let category;
  try {
    category = await store.getCategory(id);
  } catch (err) {
    return serverError(c, err);
  }
  if (!category) return notFoundPage(c);

  return render(
    c,
    200,
    "编辑分类",
    "categories",
    {
      category,
      values: { name: category.name, description: category.description },
      errors: {},
      isEdit: true,
    },
    categoryFormView,
  );
});

catalogRoutes.post("/categories/:id", async (c) => {
  const denied = requireWrite(c);
  if (denied) return denied;

  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  const values = await formValues(c, ["name", "description"]);

  try {
    await store.updateCategory(id, values.name, values.description);
  } catch (err) {
    const errors: Errors = { form: businessErrorMessage(err) };
    if (isErrorCode(err, "conflict") || isErrorCode(err, "invalidInput")) {
      errors.name = businessErrorMessage(err);
      delete errors.form;
    }
    // 回填时重新取一次分类：编辑失败后表单 action 仍要指向正确记录。
    const category = await store.getCategory(id).catch(() => null);
    return render(
      c,
      422,
      "编辑分类",
      "categories",
      { category, values, errors, isEdit: true },
      categoryFormView,
    );
  }

  return redirectWith(c, "/categories", "success", "分类已更新");
});

catalogRoutes.post("/categories/:id/delete", async (c) => {
  const denied = requireWrite(c);
  if (denied) return denied;

  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  let affected: number;
  try {
    affected = await store.deleteCategory(id);
  } catch (err) {
    return redirectWith(c, "/categories", "error", businessErrorMessage(err));
  }

  const msg =
    affected > 0 ? `分类已删除，${affected} 个商品的分类已被清空` : "分类已删除";
  return redirectWith(c, "/categories", "success", msg);
});

// ---------------------------------------------------------------------------
// 供应商
// ---------------------------------------------------------------------------

catalogRoutes.get("/suppliers", async (c) => {
  const store = c.get("store");
  const search = (c.req.query("q") ?? "").trim();
  const page = parsePage(c.req.query("page"));
  const perPage = parsePerPage(c.req.query("per_page"));

  try {
    const { suppliers, pagination } = await store.listSuppliers({ search, page, perPage });
    return render(
      c,
      200,
      "供应商管理",
      "suppliers",
      { suppliers, pagination, search, query: currentQueryWithoutPage(c) },
      supplierListView,
    );
  } catch (err) {
    return serverError(c, err);
  }
});

// ⚠️ /suppliers/new 必须注册在 /suppliers/:id 之前，否则「new」会被当成 id。
catalogRoutes.get("/suppliers/new", async (c) => {
  const denied = requireWrite(c);
  if (denied) return denied;

  return render(
    c,
    200,
    "新建供应商",
    "suppliers",
    { supplier: null, values: {}, errors: {}, isEdit: false },
    supplierFormView,
  );
});

catalogRoutes.post("/suppliers", async (c) => {
  const denied = requireWrite(c);
  if (denied) return denied;

  const store = c.get("store");
  const { input, values } = await supplierInput(c);

  try {
    const created = await store.createSupplier(input);
    return redirectWith(c, `/suppliers/${created.id}`, "success", `供应商「${created.name}」创建成功`);
  } catch (err) {
    const errors: Errors = { form: businessErrorMessage(err) };
    if (isErrorCode(err, "conflict")) {
      errors.name = businessErrorMessage(err);
      delete errors.form;
    } else if (isErrorCode(err, "invalidInput")) {
      // 与原版一致：invalidInput 留在 form 上整体提示（可能是邮箱格式等问题）。
      errors.form = businessErrorMessage(err);
    }
    return render(
      c,
      422,
      "新建供应商",
      "suppliers",
      { supplier: null, values, errors, isEdit: false },
      supplierFormView,
    );
  }
});

catalogRoutes.get("/suppliers/:id", async (c) => {
  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  let supplier;
  try {
    supplier = await store.getSupplier(id);
  } catch (err) {
    return serverError(c, err);
  }
  if (!supplier) return notFoundPage(c);

  let products;
  try {
    ({ products } = await store.listProducts({
      supplierId: id,
      page: 1,
      perPage: 50,
      sortBy: "name",
      sortDir: "asc",
    }));
  } catch (err) {
    return serverError(c, err);
  }

  return render(c, 200, supplier.name, "suppliers", { supplier, products }, supplierDetailView);
});

catalogRoutes.get("/suppliers/:id/edit", async (c) => {
  const denied = requireWrite(c);
  if (denied) return denied;

  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  let supplier;
  try {
    supplier = await store.getSupplier(id);
  } catch (err) {
    return serverError(c, err);
  }
  if (!supplier) return notFoundPage(c);

  return render(
    c,
    200,
    "编辑供应商",
    "suppliers",
    {
      supplier,
      values: {
        name: supplier.name,
        contact_person: supplier.contactPerson,
        phone: supplier.phone,
        email: supplier.email,
        address: supplier.address,
        note: supplier.note,
      },
      errors: {},
      isEdit: true,
    },
    supplierFormView,
  );
});

catalogRoutes.post("/suppliers/:id", async (c) => {
  const denied = requireWrite(c);
  if (denied) return denied;

  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  const { input, values } = await supplierInput(c);

  try {
    await store.updateSupplier(id, input);
  } catch (err) {
    const errors: Errors = { form: businessErrorMessage(err) };
    if (isErrorCode(err, "conflict")) {
      errors.name = businessErrorMessage(err);
      delete errors.form;
    }
    const supplier = await store.getSupplier(id).catch(() => null);
    return render(
      c,
      422,
      "编辑供应商",
      "suppliers",
      { supplier, values, errors, isEdit: true },
      supplierFormView,
    );
  }

  return redirectWith(c, `/suppliers/${id}`, "success", "供应商信息已更新");
});

catalogRoutes.post("/suppliers/:id/delete", async (c) => {
  const denied = requireWrite(c);
  if (denied) return denied;

  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  let affected: number;
  try {
    affected = await store.deleteSupplier(id);
  } catch (err) {
    // 有库存流水时 store 会抛 AppError，文案原样透传给用户。
    return redirectWith(c, "/suppliers", "error", businessErrorMessage(err));
  }

  const msg =
    affected > 0 ? `供应商已删除，${affected} 个商品的供应商信息已被清空` : "供应商已删除";
  return redirectWith(c, "/suppliers", "success", msg);
});
