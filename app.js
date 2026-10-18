const EMPLOYEES_KEY = "hadir-employees";
const ACCOUNTS_KEY = "hadir-accounts";
const SCHEDULE_KEY = "hadir-training-schedule";
const SESSION_KEY = "hadir-local-session";
const ATTENDANCE_KEY = `hadir-attendance-${new Date().toLocaleDateString("sv-SE")}`;
const PASSWORD_ITERATIONS = 120000;
const BARCODE_FORMATS = ["qr_code", "code_128", "code_39", "code_93", "codabar", "ean_13", "ean_8", "itf", "upc_a", "upc_e", "data_matrix", "pdf417", "aztec"];
const AVATAR_COLORS = [
  { background: "#f5e9df", foreground: "#9b6842" },
  { background: "#e7edf9", foreground: "#5675ac" },
  { background: "#f5e8f1", foreground: "#a0608a" },
  { background: "#e8f0e5", foreground: "#5f895a" },
  { background: "#f8eddf", foreground: "#a77b37" },
  { background: "#e8ebf7", foreground: "#6671a8" },
  { background: "#f5e9e6", foreground: "#a96559" },
  { background: "#e4f0ec", foreground: "#4c8470" },
];

const attendanceRows = document.querySelector("#attendance-rows");
const searchInput = document.querySelector("#search-input");
const emptyState = document.querySelector("#empty-state");
const modal = document.querySelector("#scanner-modal");
const video = document.querySelector("#camera-video");
const cameraFrame = document.querySelector("#camera-frame");
const cameraStatus = document.querySelector("#camera-status");
const cameraButton = document.querySelector("#start-camera");
const scanFeedback = document.querySelector("#scan-feedback");
const manualCode = document.querySelector("#employee-code");
const toast = document.querySelector("#toast");

let nextEmployeeNumber = 1;
let EMPLOYEES = [];
let trainingSchedule = null;
let attendance = [];
let accounts = [];
let currentUser = null;
let mediaStream = null;
let barcodeDetector = null;
let zxingReader = null;
let zxingControls = null;
let scanTimer = null;
let scanInProgress = false;
let toastTimer = null;
let lastScannedCode = "";
let lastScannedAt = 0;
let returnFocusTo = null;
let activeBarcodeEmployee = null;

function loadAccounts() {
  const saved = localStorage.getItem(ACCOUNTS_KEY);
  if (saved === null) return [];
  const parsed = JSON.parse(saved);
  if (!Array.isArray(parsed)) throw new Error("Data akun tersimpan tidak valid.");
  const validAccounts = parsed.filter((account) => (
    account
    && typeof account.id === "string"
    && typeof account.username === "string"
    && typeof account.fullName === "string"
    && typeof account.passwordHash === "string"
    && /^[\da-f]{64}$/.test(account.passwordHash)
    && typeof account.passwordSalt === "string"
    && /^[\da-f]{32}$/.test(account.passwordSalt)
    && ["admin", "member"].includes(account.role)
  ));
  if (validAccounts.length !== parsed.length) throw new Error("Data akun tersimpan tidak valid.");
  return validAccounts;
}

function saveAccounts() {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

function loadEmployees() {
  const saved = localStorage.getItem(EMPLOYEES_KEY);
  if (saved === null) return [];
  const parsed = JSON.parse(saved);
  const storedEmployees = Array.isArray(parsed) ? parsed : parsed.employees;
  if (!Array.isArray(storedEmployees)) throw new Error("Daftar pesilat tersimpan tidak valid.");
  nextEmployeeNumber = Math.max(
    Number.isInteger(parsed.nextSequence) ? parsed.nextSequence : 1,
    ...storedEmployees.map((employee) => Number(
      (typeof employee?.code === "string" ? employee.code.match(/^SILAT-(\d+)$/)?.[1] : 0) || 0,
    ) + 1),
  );
  return storedEmployees.filter((employee) => (
    employee
    && typeof employee.code === "string"
    && typeof employee.name === "string"
    && typeof employee.role === "string"
    && typeof employee.department === "string"
  )).map((employee, index) => {
    const color = AVATAR_COLORS[index % AVATAR_COLORS.length];
    return {
      ...employee,
      id: employee.id || crypto.randomUUID(),
      ownerId: employee.ownerId || null,
      initials: employee.initials || makeInitials(employee.name),
      color: employee.color || color.background,
      text: employee.text || color.foreground,
    };
  });
}

function saveEmployees() {
  localStorage.setItem(EMPLOYEES_KEY, JSON.stringify({ employees: EMPLOYEES, nextSequence: nextEmployeeNumber }));
}

function loadTrainingSchedule() {
  const saved = localStorage.getItem(SCHEDULE_KEY);
  if (!saved) return null;
  const schedule = JSON.parse(saved);
  if (
    typeof schedule.start !== "string"
    || typeof schedule.end !== "string"
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.start)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.end)
    || schedule.end <= schedule.start
  ) {
    throw new Error("Jadwal latihan tersimpan tidak valid.");
  }
  return schedule;
}

function loadAttendance() {
  const saved = localStorage.getItem(ATTENDANCE_KEY);
  if (saved === null) return [];
  const parsed = JSON.parse(saved);
  if (!Array.isArray(parsed)) throw new Error("Data absensi tersimpan tidak valid.");
  return parsed.filter((record) => (
    record && typeof record.code === "string" && typeof record.time === "string"
  ));
}

function saveAttendance() {
  localStorage.setItem(ATTENDANCE_KEY, JSON.stringify(attendance));
}

function makeEmployee(name, role, department, ownerId = null) {
  const color = AVATAR_COLORS[EMPLOYEES.length % AVATAR_COLORS.length];
  const employee = {
    id: crypto.randomUUID(),
    ownerId,
    code: `SILAT-${String(nextEmployeeNumber).padStart(3, "0")}`,
    name,
    role,
    department,
    initials: makeInitials(name),
    color: color.background,
    text: color.foreground,
  };
  nextEmployeeNumber += 1;
  return employee;
}

function renderTrainingSchedule() {
  document.querySelector("#training-start").value = trainingSchedule?.start ?? "";
  document.querySelector("#training-end").value = trainingSchedule?.end ?? "";
  document.querySelector("#schedule-summary").textContent = trainingSchedule
    ? `Latihan berlangsung pukul ${trainingSchedule.start}–${trainingSchedule.end}. Kehadiran setelah jam mulai ditandai terlambat.`
    : "Atur waktu mulai dan selesai latihan.";
}

function saveTrainingSchedule(event) {
  event.preventDefault();
  const start = document.querySelector("#training-start").value;
  const end = document.querySelector("#training-end").value;
  const feedback = document.querySelector("#schedule-feedback");
  if (!start || !end) {
    feedback.textContent = "Pilih jam mulai dan jam selesai latihan.";
    feedback.classList.add("is-error");
    return;
  }
  if (end <= start) {
    feedback.textContent = "Jam selesai harus lebih akhir daripada jam mulai pada hari yang sama.";
    feedback.classList.add("is-error");
    return;
  }

  const previousSchedule = trainingSchedule;
  trainingSchedule = { start, end };
  try {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(trainingSchedule));
  } catch (error) {
    trainingSchedule = previousSchedule;
    console.error("Tidak dapat menyimpan jadwal latihan.", error);
    feedback.textContent = "Jadwal tidak dapat disimpan. Periksa ruang penyimpanan browser.";
    feedback.classList.add("is-error");
    return;
  }
  feedback.textContent = "Jadwal latihan berhasil disimpan.";
  feedback.classList.remove("is-error");
  renderTrainingSchedule();
  renderAttendance();
  showToast("Jadwal latihan berhasil diperbarui.");
}

function setAuthFeedback(message, isError = false) {
  const feedback = document.querySelector("#auth-feedback");
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
}

function setAuthTab(tab) {
  const signup = tab === "signup";
  document.querySelector("#login-form").hidden = signup;
  document.querySelector("#signup-form").hidden = !signup;
  document.querySelector("#show-login").classList.toggle("is-active", !signup);
  document.querySelector("#show-signup").classList.toggle("is-active", signup);
  document.querySelector("#show-login").setAttribute("aria-selected", String(!signup));
  document.querySelector("#show-signup").setAttribute("aria-selected", String(signup));
  document.querySelector("#auth-title").textContent = signup ? "Gabung perguruan" : "Selamat datang";
  document.querySelector("#signup-name").previousElementSibling.textContent = accounts.length === 0
    ? "Nama admin"
    : "Nama lengkap";
  document.querySelector("#signup-form button[type=submit]").textContent = accounts.length === 0
    ? "Buat akun admin pertama"
    : "Daftar sebagai pesilat";
  setAuthFeedback("");
}

function showSignedOut(message = "") {
  currentUser = null;
  EMPLOYEES = [];
  attendance = [];
  trainingSchedule = null;
  document.querySelector(".app-shell").hidden = true;
  document.querySelector("#auth-screen").hidden = false;
  setAuthFeedback(message, Boolean(message));
}

function loadAccountData(account) {
  accounts = loadAccounts();
  currentUser = accounts.find((item) => item.id === account.id);
  if (!currentUser) throw new Error("Akun tidak ditemukan di penyimpanan browser.");
  const allEmployees = loadEmployees();
  EMPLOYEES = currentUser.role === "admin"
    ? allEmployees
    : allEmployees.filter((employee) => employee.ownerId === currentUser.id);
  trainingSchedule = loadTrainingSchedule();
  attendance = loadAttendance().filter((record) => EMPLOYEES.some((employee) => employee.code === record.code));
  const isAdmin = currentUser.role === "admin";
  document.body.classList.toggle("is-member", !isAdmin);
  document.querySelectorAll(".admin-only").forEach((element) => { element.hidden = !isAdmin; });
  document.querySelector("#open-my-barcode").hidden = isAdmin || !currentUser.memberCode;
  document.querySelector("#profile-name").textContent = currentUser.fullName;
  document.querySelector("#profile-role").textContent = isAdmin ? "Admin perguruan" : "Pesilat";
  document.querySelector("#top-avatar").textContent = makeInitials(currentUser.fullName);
  document.querySelector(".avatar-admin").textContent = makeInitials(currentUser.fullName);
  document.querySelector(".app-shell").hidden = false;
  document.querySelector("#auth-screen").hidden = true;
  renderTrainingSchedule();
  renderEmployeeDirectory();
}

function startApplication() {
  formatToday();
  document.querySelector("#current-year").textContent = new Date().getFullYear();
  try {
    accounts = loadAccounts();
    const sessionId = sessionStorage.getItem(SESSION_KEY);
    const account = accounts.find((item) => item.id === sessionId);
    if (!account) {
      showSignedOut();
      return;
    }
    loadAccountData(account);
  } catch (loadError) {
    console.error("Tidak dapat membaca data lokal.", loadError);
    showSignedOut(`Data lokal tidak dapat dibaca: ${loadError.message}`);
  }
}

function formatToday() {
  const date = new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
  document.querySelector("#full-date").textContent = date.toLocaleUpperCase("id-ID");
}

function getEmployee(code) {
  return EMPLOYEES.find((employee) => employee.code === code);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function makeInitials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase("id-ID");
}

function employeeCount() {
  return EMPLOYEES.length;
}

function renderAttendance() {
  const query = searchInput.value.trim().toLocaleLowerCase("id-ID");
  const records = attendance
    .map((record) => ({ ...record, employee: getEmployee(record.code) }))
    .filter((record) => record.employee)
    .sort((a, b) => a.time.localeCompare(b.time))
    .filter(({ employee }) => `${employee.name} ${employee.department} ${employee.code}`.toLocaleLowerCase("id-ID").includes(query));

  attendanceRows.innerHTML = records.map(({ employee, time }) => {
    const employeeName = escapeHtml(employee.name);
    const employeeCode = escapeHtml(employee.code);
    const department = escapeHtml(employee.department);
    const late = trainingSchedule && time > trainingSchedule.start;
    return `
      <tr>
        <td>
          <div class="employee-cell">
            <span class="employee-avatar" style="background:${employee.color};color:${employee.text}">${escapeHtml(employee.initials)}</span>
            <span class="employee-name"><strong>${employeeName}</strong><span>${employeeCode}</span></span>
          </div>
        </td>
        <td>${department}</td>
        <td><span class="time-cell"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>${time} WIB</span></td>
        <td><span class="status-badge${late ? " is-late" : ""}">${late ? "Terlambat" : "Hadir"}</span></td>
        <td></td>
      </tr>`;
  }).join("");

  const presentCount = attendance.length;
  const total = employeeCount();
  document.querySelector("#present-count").textContent = presentCount;
  document.querySelector("#latest-attendance").textContent = attendance.length
    ? attendance.reduce((latest, record) => (record.time > latest ? record.time : latest), "")
    : "—";
  document.querySelector("#absent-count").textContent = Math.max(0, total - presentCount);
  document.querySelector("#attendance-percent").textContent = `${total ? Math.round((presentCount / total) * 100) : 0}%`;
  document.querySelector("#total-employees").textContent = total;
  document.querySelector("#total-inline").textContent = total;
  document.querySelector("#results-count").textContent = `Menampilkan ${records.length} dari ${presentCount} pesilat`;
  emptyState.hidden = records.length > 0;
  const noEmployees = total === 0;
  document.querySelector("#attendance-empty-title").textContent = noEmployees ? "Belum ada pesilat terdaftar" : "Tidak ada data ditemukan";
  document.querySelector("#attendance-empty-description").textContent = noEmployees
    ? "Tambahkan anggota perguruan terlebih dahulu untuk mulai mencatat kehadiran latihan."
    : "Coba kata kunci lain atau scan barcode pesilat.";
  attendanceRows.closest(".table-scroll").classList.toggle("has-empty-state", records.length === 0);
}

function renderEmployeeDirectory() {
  document.querySelector("#employee-rows").innerHTML = EMPLOYEES.map((employee) => `
    <tr>
      <td>
        <div class="employee-cell">
          <span class="employee-avatar" style="background:${employee.color};color:${employee.text}">${escapeHtml(employee.initials)}</span>
          <span class="employee-name"><strong>${escapeHtml(employee.name)}</strong><span>${escapeHtml(employee.department)}</span></span>
        </div>
      </td>
      <td>${escapeHtml(employee.role)}</td>
      <td>${escapeHtml(employee.department)}</td>
      <td><code class="employee-code">${escapeHtml(employee.code)}</code></td>
      <td><div class="employee-row-actions">
        <button class="row-action-button barcode-row-button" type="button" data-action="barcode" data-code="${escapeHtml(employee.code)}">Lihat barcode</button>
        <button class="row-action-button delete-row-button" type="button" data-action="delete" data-code="${escapeHtml(employee.code)}" aria-label="Hapus ${escapeHtml(employee.name)}">Hapus</button>
      </div></td>
    </tr>`).join("");
  const total = employeeCount();
  document.querySelector("#directory-count").textContent = `${total} pesilat`;
  document.querySelector("#directory-empty").hidden = total > 0;
  document.querySelector("#employee-rows").closest(".table-scroll").hidden = total === 0;
  document.querySelector("#total-employees").textContent = total;
  document.querySelector("#total-inline").textContent = total;
  renderAttendance();
}

function openEmployeeForm() {
  const form = document.querySelector("#employee-form");
  form.reset();
  document.querySelector("#employee-form-feedback").textContent = "";
  document.querySelector("#employee-modal").hidden = false;
  document.body.classList.add("modal-open");
  window.setTimeout(() => document.querySelector("#new-employee-name").focus(), 0);
}

function closeEmployeeForm() {
  document.querySelector("#employee-modal").hidden = true;
  updateModalScrollLock();
  document.querySelector("#open-employee-form").focus();
}

function addEmployee(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const name = String(formData.get("name")).trim();
  const role = String(formData.get("role")).trim();
  const department = String(formData.get("department")).trim();
  const feedback = document.querySelector("#employee-form-feedback");
  if (!name || !role || !department) {
    feedback.textContent = "Lengkapi nama, tingkat sabuk, dan kelompok latihan terlebih dahulu.";
    return;
  }

  const previousSequence = nextEmployeeNumber;
  const employee = makeEmployee(name, role, department);
  EMPLOYEES.push(employee);
  try {
    saveEmployees();
  } catch (error) {
    EMPLOYEES.pop();
    nextEmployeeNumber = previousSequence;
    console.error("Tidak dapat menyimpan pesilat.", error);
    feedback.textContent = "Data pesilat tidak dapat disimpan. Periksa ruang penyimpanan browser.";
    return;
  }
  renderEmployeeDirectory();
  closeEmployeeForm();
  openBarcode(employee.code);
}

function removeEmployee(code) {
  const employee = getEmployee(code);
  if (!employee || !window.confirm(`Hapus data pesilat ${employee.name}? Riwayat kehadiran latihan ini juga akan dihapus.`)) return;
  const previousEmployees = EMPLOYEES;
  const previousAttendance = attendance;
  const previousAllEmployees = loadEmployees();
  const previousAllAttendance = loadAttendance();
  const storedEmployees = localStorage.getItem(EMPLOYEES_KEY);
  const storedAttendance = localStorage.getItem(ATTENDANCE_KEY);
  const updatedEmployees = previousAllEmployees.filter((record) => record.code !== code);
  const updatedAttendance = previousAllAttendance.filter((record) => record.code !== code);
  try {
    localStorage.setItem(EMPLOYEES_KEY, JSON.stringify({ employees: updatedEmployees, nextSequence: nextEmployeeNumber }));
    localStorage.setItem(ATTENDANCE_KEY, JSON.stringify(updatedAttendance));
    EMPLOYEES = EMPLOYEES.filter((record) => record.code !== code);
    attendance = attendance.filter((record) => record.code !== code);
  } catch (error) {
    console.error("Tidak dapat menyimpan perubahan setelah menghapus pesilat.", error);
    try {
      if (storedEmployees === null) localStorage.removeItem(EMPLOYEES_KEY);
      else localStorage.setItem(EMPLOYEES_KEY, storedEmployees);
      if (storedAttendance === null) localStorage.removeItem(ATTENDANCE_KEY);
      else localStorage.setItem(ATTENDANCE_KEY, storedAttendance);
    } catch (restoreError) {
      console.error("Tidak dapat memulihkan data setelah penghapusan pesilat gagal.", restoreError);
    }
    EMPLOYEES = previousEmployees;
    attendance = previousAttendance;
    showToast("Pesilat tidak dapat dihapus. Periksa ruang penyimpanan browser.", true);
    return;
  }
  renderEmployeeDirectory();
  showToast("Data pesilat dan kehadiran latihan ini berhasil dihapus.");
}

function openBarcode(code) {
  const employee = getEmployee(code);
  if (!employee) {
    showToast("Data pesilat tidak ditemukan.", true);
    return;
  }
  if (typeof window.JsBarcode !== "function") {
    showToast("Pembuat barcode kartu anggota belum termuat. Periksa koneksi internet lalu muat ulang halaman.", true);
    return;
  }

  activeBarcodeEmployee = employee;
  document.querySelector("#barcode-employee-name").textContent = employee.name;
  document.querySelector("#barcode-employee-detail").textContent = `${employee.role} · ${employee.department}`;
  document.querySelector("#barcode-employee-code").textContent = employee.code;
  const barcode = document.querySelector("#generated-barcode");
  barcode.replaceChildren();
  try {
    window.JsBarcode(barcode, employee.code, {
      format: "CODE128",
      displayValue: true,
      height: 72,
      margin: 12,
      width: 2,
      fontSize: 15,
      textMargin: 5,
      lineColor: "#19241d",
      background: "#ffffff",
    });
  } catch (error) {
    console.error("Tidak dapat membuat barcode anggota.", error);
    showToast(`Barcode tidak dapat dibuat: ${error.message}`, true);
    return;
  }
  document.querySelector("#barcode-modal").hidden = false;
  document.body.classList.add("modal-open");
}

function closeBarcode() {
  document.querySelector("#barcode-modal").hidden = true;
  activeBarcodeEmployee = null;
  updateModalScrollLock();
}

function updateModalScrollLock() {
  const anyModalOpen = ["#scanner-modal", "#employee-modal", "#barcode-modal"]
    .some((selector) => !document.querySelector(selector).hidden);
  document.body.classList.toggle("modal-open", anyModalOpen);
}

function downloadBarcode() {
  if (!activeBarcodeEmployee) return;
  const svg = document.querySelector("#generated-barcode").cloneNode(true);
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const source = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `barcode-${activeBarcodeEmployee.code.toLowerCase()}.svg`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Barcode berhasil diunduh.");
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function createPasswordSalt() {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(salt, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  if (!crypto.subtle) throw new Error("Pembuatan akun perlu dibuka melalui localhost atau HTTPS.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: Uint8Array.from(salt.match(/.{2}/g), (byte) => Number.parseInt(byte, 16)),
    iterations: PASSWORD_ITERATIONS,
    hash: "SHA-256",
  }, key, 256);
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyPassword(password, salt, expectedHash) {
  const actualHash = await hashPassword(password, salt);
  if (actualHash.length !== expectedHash.length) return false;
  let difference = 0;
  for (let index = 0; index < actualHash.length; index += 1) {
    difference |= actualHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return difference === 0;
}

async function signIn(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const values = new FormData(form);
  const username = String(values.get("username")).trim().toLocaleLowerCase("en-US");
  const password = String(values.get("password"));
  button.disabled = true;
  setAuthFeedback("");
  try {
    accounts = loadAccounts();
    const account = accounts.find((item) => item.username === username);
    if (!account || !await verifyPassword(password, account.passwordSalt, account.passwordHash)) {
      throw new Error("Nama pengguna atau kata sandi tidak sesuai.");
    }
    sessionStorage.setItem(SESSION_KEY, account.id);
    loadAccountData(account);
  } catch (error) {
    console.error("Tidak dapat masuk ke akun.", error);
    setAuthFeedback(`Tidak dapat masuk: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

async function signUp(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const values = new FormData(form);
  const username = String(values.get("username")).trim().toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) {
    setAuthFeedback("Nama pengguna harus 3–30 karakter dan hanya berisi huruf, angka, titik, garis bawah, atau tanda hubung.", true);
    return;
  }
  button.disabled = true;
  setAuthFeedback("");
  try {
    accounts = loadAccounts();
    if (accounts.some((account) => account.username === username)) {
      throw new Error("Nama pengguna itu sudah dipakai.");
    }
    const password = String(values.get("password"));
    if (password.length < 8) throw new Error("Kata sandi minimal 8 karakter.");
    const fullName = String(values.get("full_name")).trim();
    if (!fullName) throw new Error("Nama lengkap wajib diisi.");
    const accountId = crypto.randomUUID();
    const passwordSalt = createPasswordSalt();
    const passwordHash = await hashPassword(password, passwordSalt);
    const isFirstAccount = accounts.length === 0;
    const account = {
      id: accountId,
      username,
      fullName,
      role: isFirstAccount ? "admin" : "member",
      passwordSalt,
      passwordHash,
      memberCode: null,
    };
    const oldAccounts = accounts;
    const allEmployees = loadEmployees();
    const previousEmployees = allEmployees.slice();
    const oldSequence = nextEmployeeNumber;
    if (!isFirstAccount) {
      const employee = makeEmployee(
        fullName,
        String(values.get("belt")).trim() || "Belum ditentukan",
        String(values.get("training_group")).trim() || "Umum",
        accountId,
      );
      account.memberCode = employee.code;
      allEmployees.push(employee);
    }
    accounts = [...accounts, account];
    try {
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
      localStorage.setItem(EMPLOYEES_KEY, JSON.stringify({ employees: allEmployees, nextSequence: nextEmployeeNumber }));
    } catch (error) {
      accounts = oldAccounts;
      nextEmployeeNumber = oldSequence;
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(oldAccounts));
      localStorage.setItem(EMPLOYEES_KEY, JSON.stringify({ employees: previousEmployees, nextSequence: oldSequence }));
      throw new Error("Akun tidak dapat disimpan. Periksa ruang penyimpanan browser.");
    }
    sessionStorage.setItem(SESSION_KEY, account.id);
    form.reset();
    loadAccountData(account);
    if (account.memberCode) openBarcode(account.memberCode);
  } catch (error) {
    console.error("Tidak dapat membuat akun.", error);
    setAuthFeedback(`Akun tidak dapat dibuat: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

function signOut() {
  sessionStorage.removeItem(SESSION_KEY);
  document.body.classList.remove("is-member");
  showSignedOut();
}

function setFeedback(message, isError = false) {
  scanFeedback.textContent = message;
  scanFeedback.classList.toggle("is-error", isError);
}

function setCameraStatus(message, isError = false) {
  cameraStatus.lastChild.textContent = ` ${message}`;
  cameraStatus.classList.toggle("is-error", isError);
}

function registerAttendance(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (!code) {
    setFeedback("Masukkan kode barcode pesilat terlebih dahulu.", true);
    return false;
  }
  const employee = getEmployee(code);
  if (!employee) {
    const message = `Kode anggota “${code}” tidak terdaftar. Periksa kode lalu coba lagi.`;
    setFeedback(message, true);
    showToast(message, true);
    return false;
  }
  if (attendance.some((record) => record.code === employee.code)) {
    const message = `${employee.name} sudah tercatat hadir pada latihan ini.`;
    setFeedback(message, true);
    showToast(message, true);
    return false;
  }
  if (currentUser.role !== "admin" && employee.ownerId !== currentUser.id) {
    setFeedback("Akun pesilat hanya dapat mencatat kehadiran dengan kode miliknya sendiri.", true);
    return false;
  }

  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  try {
    attendance.push({ code: employee.code, time });
    saveAttendance();
  } catch (error) {
    console.error("Tidak dapat mencatat kehadiran.", error);
    attendance = attendance.filter((record) => record.code !== employee.code);
    setFeedback("Kehadiran tidak dapat disimpan. Periksa ruang penyimpanan browser.", true);
    showToast("Kehadiran tidak dapat disimpan. Periksa ruang penyimpanan browser.", true);
    return false;
  }
  renderAttendance();
  const message = `${employee.name} berhasil dicatat hadir latihan pukul ${time} WIB.`;
  setFeedback(message);
  showToast(message);
  manualCode.value = "";
  return true;
}

function openScanner(event) {
  returnFocusTo = event.currentTarget;
  modal.hidden = false;
  document.body.classList.add("modal-open");
  setFeedback("");
  window.setTimeout(() => document.querySelector("#close-scanner").focus(), 0);
}

function stopCamera() {
  if (scanTimer !== null) {
    window.clearInterval(scanTimer);
    scanTimer = null;
  }
  if (zxingControls) {
    zxingControls.stop();
    zxingControls = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((track) => track.stop());
  }
  video.srcObject = null;
  cameraFrame.classList.remove("is-live");
  cameraButton.disabled = false;
  cameraButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h-4l-2 2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2-2Z"></path><circle cx="12" cy="13" r="3"></circle></svg>Aktifkan kamera';
  setCameraStatus("SIAP MEMINDAI");
}

function closeScanner() {
  stopCamera();
  modal.hidden = true;
  document.body.classList.remove("modal-open");
  if (returnFocusTo) returnFocusTo.focus();
}

async function scanVideoFrame() {
  if (!mediaStream || scanInProgress || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  scanInProgress = true;
  try {
    const results = await barcodeDetector.detect(video);
    const result = results[0];
    if (result?.rawValue) {
      handleDetectedCode(result.rawValue);
    }
  } catch (error) {
    console.error("Terjadi kesalahan saat membaca barcode.", error);
    setCameraStatus("GAGAL MEMBACA BARCODE", true);
    setFeedback("Pemindai mengalami kendala. Masukkan kode secara manual atau mulai ulang kamera.", true);
  } finally {
    scanInProgress = false;
  }
}

function handleDetectedCode(rawCode) {
  const code = rawCode.trim().toUpperCase();
  const now = Date.now();
  if (code === lastScannedCode && now - lastScannedAt < 5000) return;
  lastScannedCode = code;
  lastScannedAt = now;
  registerAttendance(code);
}

async function startCamera() {
  setFeedback("");
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = "Browser ini tidak menyediakan akses kamera. Masukkan kode barcode secara manual.";
    setCameraStatus("KAMERA TIDAK TERSEDIA", true);
    setFeedback(message, true);
    return;
  }
  const hasNativeDetector = typeof window.BarcodeDetector === "function";
  const hasZXingDetector = typeof window.ZXingBrowser?.BrowserMultiFormatReader === "function";
  if (!hasNativeDetector && !hasZXingDetector) {
    const message = "Browser ini belum mendukung pemindaian barcode otomatis. Masukkan kode secara manual.";
    setCameraStatus("SCAN OTOMATIS TIDAK DIDUKUNG", true);
    setFeedback(message, true);
    return;
  }

  cameraButton.disabled = true;
  cameraButton.textContent = "Mengaktifkan kamera...";
  try {
    if (hasZXingDetector) {
      zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader();
      zxingControls = await zxingReader.decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: "environment" } } },
        video,
        (result, error) => {
          if (result) {
            handleDetectedCode(result.getText());
          } else if (error && !["NotFoundException", "ChecksumException", "FormatException"].includes(error.name)) {
            console.error("Terjadi kesalahan saat membaca barcode.", error);
            setFeedback("Pemindai mengalami kendala. Masukkan kode secara manual atau mulai ulang kamera.", true);
          }
        },
      );
      mediaStream = video.srcObject;
    } else {
      const supportedFormats = typeof window.BarcodeDetector.getSupportedFormats === "function"
        ? await window.BarcodeDetector.getSupportedFormats()
        : null;
      const detectorFormats = supportedFormats
        ? BARCODE_FORMATS.filter((format) => supportedFormats.includes(format))
        : BARCODE_FORMATS;
      if (supportedFormats && detectorFormats.length === 0) {
        throw new Error("Browser tidak mendukung format barcode yang dikenal.");
      }
      barcodeDetector = new window.BarcodeDetector({ formats: detectorFormats });
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      video.srcObject = mediaStream;
      await video.play();
      scanTimer = window.setInterval(scanVideoFrame, 250);
    }
    cameraFrame.classList.add("is-live");
    cameraButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h-4l-2 2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2-2Z"></path><circle cx="12" cy="13" r="3"></circle></svg>Kamera aktif';
    cameraButton.disabled = true;
    setCameraStatus("KAMERA AKTIF");
  } catch (error) {
    stopCamera();
    console.error("Tidak dapat mengaktifkan kamera.", error);
    const message = error.name === "NotAllowedError"
      ? "Izin kamera ditolak. Izinkan akses kamera di browser, atau masukkan kode secara manual."
      : error.name === "NotFoundError"
        ? "Kamera tidak ditemukan pada perangkat ini. Masukkan kode secara manual."
        : `Kamera tidak dapat diaktifkan: ${error.message || "kesalahan tidak diketahui"}.`;
    setCameraStatus("KAMERA TIDAK AKTIF", true);
    setFeedback(message, true);
  }
}

function exportCsv() {
  const rows = [
    ["Kode Anggota", "Nama Pesilat", "Kelompok Latihan", "Jam Hadir", "Status"],
    ...attendance
      .map((record) => ({ ...record, employee: getEmployee(record.code) }))
      .filter((record) => record.employee)
      .sort((a, b) => a.time.localeCompare(b.time))
      .map(({ employee, time }) => [
        employee.code,
        employee.name,
        employee.department,
        `${time} WIB`,
        trainingSchedule && time > trainingSchedule.start ? "Terlambat" : "Hadir",
      ]),
  ];
  const csv = `\uFEFF${rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `absensi-latihan-silat-${new Date().toLocaleDateString("sv-SE")}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Data kehadiran berhasil diekspor ke CSV.");
}

document.querySelector(".app-shell").hidden = true;
document.querySelector("#show-login").addEventListener("click", () => setAuthTab("login"));
document.querySelector("#show-signup").addEventListener("click", () => setAuthTab("signup"));
document.querySelector("#login-form").addEventListener("submit", signIn);
document.querySelector("#signup-form").addEventListener("submit", signUp);
document.querySelector("#sign-out").addEventListener("click", signOut);
document.querySelector("#open-my-barcode").addEventListener("click", () => {
  if (currentUser?.memberCode) openBarcode(currentUser.memberCode);
});
startApplication();
document.querySelectorAll("#open-scanner, #open-scanner-card").forEach((button) => button.addEventListener("click", openScanner));
document.querySelector("#close-scanner").addEventListener("click", closeScanner);
cameraButton.addEventListener("click", startCamera);
searchInput.addEventListener("input", renderAttendance);
document.querySelector("#export-csv").addEventListener("click", exportCsv);
document.querySelector("#schedule-form").addEventListener("submit", saveTrainingSchedule);
document.querySelector("#open-employee-form").addEventListener("click", openEmployeeForm);
document.querySelector("#close-employee-form").addEventListener("click", closeEmployeeForm);
document.querySelector("#cancel-employee-form").addEventListener("click", closeEmployeeForm);
document.querySelector("#employee-form").addEventListener("submit", addEmployee);
document.querySelector("#close-barcode").addEventListener("click", closeBarcode);
document.querySelector("#download-barcode").addEventListener("click", downloadBarcode);
document.querySelector("#print-barcode").addEventListener("click", () => window.print());
document.querySelector("#employee-rows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "barcode") openBarcode(button.dataset.code);
  if (button.dataset.action === "delete") removeEmployee(button.dataset.code);
});
document.querySelector("#manual-entry").addEventListener("submit", (event) => {
  event.preventDefault();
  registerAttendance(manualCode.value);
});
modal.addEventListener("click", (event) => {
  if (event.target === modal) closeScanner();
});
document.querySelector("#employee-modal").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeEmployeeForm();
});
document.querySelector("#barcode-modal").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeBarcode();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!modal.hidden) closeScanner();
  else if (!document.querySelector("#employee-modal").hidden) closeEmployeeForm();
  else if (!document.querySelector("#barcode-modal").hidden) closeBarcode();
});
window.addEventListener("pagehide", stopCamera);
