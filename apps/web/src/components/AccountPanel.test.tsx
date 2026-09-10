import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { setCatalog, setLocale } from "../i18n/messages";
import { store } from "../state/store";
import { AccountPanel } from "./AccountPanel";

setCatalog({
  otp_invalid: "รหัสไม่ถูกต้อง",
  verification_sent: "ส่งรหัสยืนยันไปทางอีเมลแล้ว",
  otp_sent: "ส่งรหัสใหม่แล้ว",
  welcome_back: "ยินดีต้อนรับกลับมา {name}",
  weak_password: "รหัสผ่านสั้นเกินไป",
});

const account = {
  id: "user_1",
  name: "ผู้เล่น",
  username: null,
  email: "player@example.com",
  verified: false,
  rating: 1200,
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  draws: 0,
};

/** เขียนสถานะตรง ๆ เพื่อจัดฉาก — เร็วและตรงกว่าการไล่กดจนถึงหน้าที่อยากทดสอบ */
const setState = (patch: Record<string, unknown>) =>
  (store as unknown as { set(patch: Record<string, unknown>): void }).set(patch);

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  // ล้าง localStorage ทิ้งภาษาที่ setup ตรึงไว้ไปด้วย ต้องตั้งกลับ
  setLocale("th");
  setState({
    accountsEnabled: true,
    account: null,
    googleClientId: null,
    pendingVerification: null,
    passwordReset: null,
    toasts: [],
  });
});

function mockFetch(response: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => response,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("สมัครด้วยอีเมลแล้วขึ้นช่องกรอกรหัสยืนยันทันที", async () => {
  mockFetch({ token: "t1", user: account, verificationRequired: true });
  render(<AccountPanel />);

  await userEvent.type(screen.getByLabelText("อีเมลหรือชื่อผู้ใช้"), "player@example.com");
  await userEvent.type(screen.getByLabelText("รหัสผ่าน"), "password1234");
  await userEvent.click(screen.getByRole("button", { name: "สมัครใหม่" }));

  expect(await screen.findByLabelText("รหัสหกหลัก")).toBeInTheDocument();
  expect(screen.getByText(/player@example\.com/)).toBeInTheDocument();
});

test("รหัสผิดขึ้นข้อความจากรหัสที่เซิร์ฟเวอร์ส่งมา แล้วยังกรอกใหม่ได้", async () => {
  setState({ pendingVerification: "player@example.com" });
  mockFetch({ code: "otp_invalid" }, false, 400);
  render(<AccountPanel />);

  await userEvent.type(screen.getByLabelText("รหัสหกหลัก"), "000000");
  await userEvent.click(screen.getByRole("button", { name: "ยืนยัน" }));

  expect(await screen.findByText("รหัสไม่ถูกต้อง")).toBeInTheDocument();
  expect(screen.getByLabelText("รหัสหกหลัก")).toBeInTheDocument();
});

test("ยืนยันไม่ได้จนกว่าจะครบหกหลัก", async () => {
  setState({ pendingVerification: "player@example.com" });
  render(<AccountPanel />);

  const submit = screen.getByRole("button", { name: "ยืนยัน" });
  expect(submit).toBeDisabled();
  await userEvent.type(screen.getByLabelText("รหัสหกหลัก"), "12345");
  expect(submit).toBeDisabled();
  await userEvent.type(screen.getByLabelText("รหัสหกหลัก"), "6");
  expect(submit).toBeEnabled();
});

test("กรอกได้เฉพาะตัวเลข", async () => {
  setState({ pendingVerification: "player@example.com" });
  render(<AccountPanel />);

  const field = screen.getByLabelText("รหัสหกหลัก");
  await userEvent.type(field, "12ab34");
  expect(field).toHaveValue("1234");
});

test("ปิดช่องกรอกไปก่อนได้ แล้วกลับมาเปิดใหม่จากคำเตือนในโปรไฟล์", async () => {
  setState({ account, pendingVerification: "player@example.com" });
  render(<AccountPanel />);

  await userEvent.click(screen.getByRole("button", { name: "ไว้ทีหลัง" }));
  expect(screen.queryByLabelText("รหัสหกหลัก")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "ยืนยันเลย" }));
  expect(screen.getByLabelText("รหัสหกหลัก")).toBeInTheDocument();
});

test("ไม่มี client id ก็ไม่มีปุ่ม Google และไม่โหลดสคริปต์ของ Google เลย", () => {
  render(<AccountPanel />);
  expect(document.querySelector("script[src*='accounts.google.com']")).toBeNull();
});

test("ปิดระบบบัญชีแล้วไม่แสดงอะไรเลย", () => {
  setState({ accountsEnabled: false });
  const { container } = render(<AccountPanel />);
  expect(container).toBeEmptyDOMElement();
});

test("ลืมรหัสผ่านครบวง — ขอรหัส แล้วตั้งรหัสใหม่", async () => {
  const fetchMock = mockFetch({ ok: true, code: "otp_sent" });
  render(<AccountPanel />);

  await userEvent.click(screen.getByText("มีบัญชีแล้ว หรืออยากเก็บอันดับ? เข้าสู่ระบบ / สมัคร"));
  await userEvent.type(screen.getByLabelText("อีเมลหรือชื่อผู้ใช้"), "player@example.com");
  await userEvent.click(screen.getByRole("button", { name: "ลืมรหัสผ่าน" }));

  // อีเมลที่พิมพ์ไว้ตอนล็อกอินถูกพามาให้ ไม่ต้องพิมพ์ซ้ำ
  await userEvent.click(await screen.findByRole("button", { name: "ส่งรหัส" }));
  expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/forgot-password");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).email).toBe("player@example.com");

  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ token: "t1", user: { ...account, verified: true } }),
  });
  await userEvent.type(await screen.findByLabelText("รหัสหกหลัก"), "123456");
  await userEvent.type(screen.getByLabelText("รหัสผ่านใหม่"), "brand-new-password");
  await userEvent.click(screen.getByRole("button", { name: "ตั้งรหัสผ่านใหม่" }));

  const reset = fetchMock.mock.calls.find(
    (call) => call[0] === "/api/v1/auth/reset-password",
  ) as unknown[] | undefined;
  expect(reset).toBeDefined();
  expect(JSON.parse((reset![1] as { body: string }).body)).toMatchObject({
    email: "player@example.com",
    code: "123456",
    password: "brand-new-password",
  });
});

test("ตั้งรหัสผ่านใหม่ไม่ได้จนกว่ารหัสจะครบหกหลัก", async () => {
  setState({ passwordReset: { step: "code", email: "player@example.com" } });
  render(<AccountPanel />);

  const submit = screen.getByRole("button", { name: "ตั้งรหัสผ่านใหม่" });
  expect(submit).toBeDisabled();
  await userEvent.type(screen.getByLabelText("รหัสหกหลัก"), "123456");
  expect(submit).toBeEnabled();
});

test("รหัสผ่านใหม่อ่อนเกินไปขึ้นข้อความ แล้วยังกรอกต่อได้โดยไม่เสียรหัสจากอีเมล", async () => {
  setState({ passwordReset: { step: "code", email: "player@example.com" } });
  mockFetch({ code: "weak_password" }, false, 400);
  render(<AccountPanel />);

  await userEvent.type(screen.getByLabelText("รหัสหกหลัก"), "123456");
  await userEvent.type(screen.getByLabelText("รหัสผ่านใหม่"), "sh0rt");
  await userEvent.click(screen.getByRole("button", { name: "ตั้งรหัสผ่านใหม่" }));

  expect(await screen.findByText("รหัสผ่านสั้นเกินไป")).toBeInTheDocument();
  expect(screen.getByLabelText("รหัสหกหลัก")).toHaveValue("123456");
});

test("ยกเลิกแล้วกลับไปหน้าล็อกอิน", async () => {
  setState({ passwordReset: { step: "ask", email: "" } });
  render(<AccountPanel />);

  await userEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));
  expect(screen.queryByRole("button", { name: "ส่งรหัส" })).not.toBeInTheDocument();
  expect(screen.getByText("มีบัญชีแล้ว หรืออยากเก็บอันดับ? เข้าสู่ระบบ / สมัคร")).toBeInTheDocument();
});
