-- ES Attendance – UI: main window (roster vs. group), text dialog (export / import).
local ADDON, ns = ...

local ROW_H = 20
local WIDTH, HEIGHT = 480, 600
local ICON_OK = "Interface\\RaidFrame\\ReadyCheck-Ready"
local ICON_MISSING = "Interface\\RaidFrame\\ReadyCheck-NotReady"
local ICON_ONLINE = "Interface\\RaidFrame\\ReadyCheck-Waiting"

-- WoW's default UI font (FRIZQT) has no č/ř/ě/ž glyphs; ARIALN.TTF (the chat font) does.
local FONT = "Fonts/ARIALN.TTF"   -- forward slash on purpose: no backslash escaping to get wrong
local function makeFont(name, base, size, flags)
  local f = CreateFont(name)
  f:CopyFontObject(base)
  f:SetFont(FONT, size, flags or "")
  return f
end
makeFont("ESAttendanceFontNormal", GameFontNormal, 13)
makeFont("ESAttendanceFontHighlight", GameFontHighlight, 13)
makeFont("ESAttendanceFontSmall", GameFontHighlightSmall, 12)
makeFont("ESAttendanceFontNormalSmall", GameFontNormalSmall, 12)
makeFont("ESAttendanceFontLarge", GameFontNormalLarge, 17)
makeFont("ESAttendanceFontDisabled", GameFontDisable, 13)

local main, textFrame
local textMode, importing   -- text dialog state: "import" / "export", re-entry guard
local rows = {}
local onlyMissing = false

local function classText(name, token)
  local r, g, b = ns.ClassColor(token)
  return ("|cff%02x%02x%02x%s|r"):format(r * 255, g * 255, b * 255, name)
end

local function rgbText(text, r, g, b)
  return ("|cff%02x%02x%02x%s|r"):format(r * 255, g * 255, b * 255, text)
end

-- ---------------------------------------------------------------- rows
local function acquireRow(i)
  if rows[i] then return rows[i] end
  local row = CreateFrame("Button", nil, main.content)
  row:SetSize(WIDTH - 50, ROW_H)
  row:SetPoint("TOPLEFT", 0, -(i - 1) * ROW_H)
  row.bg = row:CreateTexture(nil, "BACKGROUND")
  row.bg:SetAllPoints()
  row.bg:SetColorTexture(1, 1, 1, i % 2 == 0 and 0.04 or 0)

  row.icon = row:CreateTexture(nil, "ARTWORK")
  row.icon:SetSize(14, 14)
  row.icon:SetPoint("LEFT", 4, 0)

  row.name = row:CreateFontString(nil, "OVERLAY", "ESAttendanceFontNormal")
  row.name:SetPoint("LEFT", row.icon, "RIGHT", 6, 0)
  row.name:SetWidth(110)
  row.name:SetJustifyH("LEFT")

  row.detail = row:CreateFontString(nil, "OVERLAY", "ESAttendanceFontSmall")
  row.detail:SetPoint("LEFT", row.name, "RIGHT", 6, 0)
  row.detail:SetPoint("RIGHT", row, "RIGHT", -66, 0)
  row.detail:SetJustifyH("LEFT")
  row.detail:SetWordWrap(false)

  row.invite = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
  row.invite:SetSize(60, ROW_H - 2)
  row.invite:SetPoint("RIGHT", -2, 0)
  row.invite:SetNormalFontObject(ESAttendanceFontNormal)
  row.invite:SetHighlightFontObject(ESAttendanceFontHighlight)
  row.invite:SetText("Pozvat")
  row.invite:SetScript("OnClick", function(self) ns.InvitePlayer(self.playerIndex) end)

  row:SetScript("OnEnter", function(self)
    local p = ns.roster[self.playerIndex]
    if not p then return end
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    GameTooltip:AddLine(p.name)
    for i, ch in ipairs(p.chars) do
      local role = (p.charRole and p.charRole[i]) or ""
      local online = ns.guildOnline[ns.NormName(ch)]
      GameTooltip:AddDoubleLine(classText(ch, p.charClass[i]) .. (i == 1 and " (main)" or ""),
        (role ~= "" and role .. " · " or "") .. (online and "|cff3fd68aonline|r" or "|cff888888offline / mimo guildu|r"))
    end
    GameTooltip:Show()
  end)
  row:SetScript("OnLeave", GameTooltip_Hide)
  rows[i] = row
  return row
end

local function refreshList()
  if not main or not main:IsShown() then return end
  local shown = 0
  for idx, p in ipairs(ns.roster) do
    local pr = ns.present[idx]
    if not (onlyMissing and pr) then
      shown = shown + 1
      local row = acquireRow(shown)
      row.playerIndex = idx
      row.name:SetText(classText(p.name, p.class))
      if pr then
        row.icon:SetTexture(ICON_OK)
        local charIdx
        for i, ch in ipairs(p.chars) do if ns.NormName(ch) == ns.NormName(pr.char) then charIdx = i end end
        local charTxt = classText(pr.char, charIdx and p.charClass[charIdx] or p.class)
        if charIdx and charIdx > 1 then charTxt = charTxt .. " |cff888888(alt)|r" end
        if not pr.online then charTxt = charTxt .. " |cffff5555offline|r" end
        row.detail:SetText(charTxt)
        row.invite:Hide()
      else
        local target, online = ns.InviteTargetFor(idx)
        if online then
          row.icon:SetTexture(ICON_ONLINE)
          row.detail:SetText(rgbText("chybí", 1, 0.6, 0.2) .. " · online: " .. (target or ""))
        else
          row.icon:SetTexture(ICON_MISSING)
          row.detail:SetText(rgbText("chybí", 1, 0.35, 0.35) .. " |cff888888(nikdo online)|r")
        end
        row.invite:Show()
      end
      row:Show()
    end
  end
  for i = shown + 1, #rows do rows[i]:Hide() end
  main.content:SetHeight(math.max(shown * ROW_H, 1))

  local n, total = ns.CountPresent()
  main.summary:SetText(("V raidu |cff3fd68a%d|r / %d hráčů rosteru · skupina %d"):format(n, total, GetNumGroupMembers()))
  local stale, age = ns.RosterIsStale()
  main.rosterInfo:SetText(("Roster: %d hráčů · verze %s (%s)%s"):format(#ns.roster, ns.rosterVersion ~= "" and ns.rosterVersion or "?",
    ns.rosterSource or "", stale and (" · |cffffa040" .. (age and (age .. " dní starý") or "neznámé stáří") .. " – Import rosteru|r") or ""))
  local extra = {}
  if #ns.unknown > 0 then extra[#extra + 1] = "|cffffd100Mimo roster:|r " .. table.concat(ns.unknown, ", ") end
  local q = ns.QueuedInvites()
  if q > 0 then extra[#extra + 1] = ("|cff3fd68aČeká pozvánek: %d|r"):format(q) end
  main.status:SetText(table.concat(extra, "   "))
  main.cancelBtn:SetShown(q > 0)
  local rec = ns.LatestRecord()
  main.lastRecord:SetText(rec and ("Poslední zápis: %s %s"):format(rec.date, rec.time) or "Docházka zatím nezapsána")
end

-- ---------------------------------------------------------------- main frame
local function button(parent, text, width, onClick)
  local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
  b:SetSize(width, 22)
  b:SetNormalFontObject(ESAttendanceFontNormal)
  b:SetHighlightFontObject(ESAttendanceFontHighlight)
  b:SetDisabledFontObject(ESAttendanceFontDisabled)
  b:SetText(text)
  b:SetScript("OnClick", onClick)
  return b
end

local function createMain()
  main = CreateFrame("Frame", "ESAttendanceFrame", UIParent, "BackdropTemplate")
  main:SetSize(WIDTH, HEIGHT)
  main:SetFrameStrata("HIGH")
  main:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
    edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", tile = true, tileSize = 16, edgeSize = 16,
    insets = { left = 4, right = 4, top = 4, bottom = 4 } })
  main:SetBackdropColor(0.04, 0.05, 0.045, 0.95)
  main:SetBackdropBorderColor(0.25, 0.84, 0.54, 0.9)
  main:SetMovable(true)
  main:EnableMouse(true)
  main:RegisterForDrag("LeftButton")
  main:SetClampedToScreen(true)
  main:SetScript("OnDragStart", main.StartMoving)
  main:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local point, _, rel, x, y = self:GetPoint()
    ESAttendanceDB.pos = { point, rel, x, y }
  end)
  local pos = ESAttendanceDB.pos
  if pos then main:SetPoint(pos[1], UIParent, pos[2], pos[3], pos[4]) else main:SetPoint("CENTER") end
  tinsert(UISpecialFrames, "ESAttendanceFrame")

  local title = main:CreateFontString(nil, "OVERLAY", "ESAttendanceFontLarge")
  title:SetPoint("TOPLEFT", 14, -12)
  title:SetText("|cff3fd68aES|r Attendance")

  local close = CreateFrame("Button", nil, main, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -4, -4)

  main.summary = main:CreateFontString(nil, "OVERLAY", "ESAttendanceFontHighlight")
  main.summary:SetPoint("TOPLEFT", 14, -36)
  main.rosterInfo = main:CreateFontString(nil, "OVERLAY", "ESAttendanceFontSmall")
  main.rosterInfo:SetPoint("TOPLEFT", 14, -52)
  main.rosterInfo:SetTextColor(0.55, 0.6, 0.57)

  local cb = CreateFrame("CheckButton", nil, main, "UICheckButtonTemplate")
  cb:SetSize(24, 24)
  cb:SetPoint("TOPRIGHT", -110, -34)
  cb.text = cb:CreateFontString(nil, "OVERLAY", "ESAttendanceFontSmall")
  cb.text:SetPoint("LEFT", cb, "RIGHT", 2, 0)
  cb.text:SetText("jen chybějící")
  cb:SetScript("OnClick", function(self) onlyMissing = self:GetChecked() and true or false; refreshList() end)

  local scroll = CreateFrame("ScrollFrame", "ESAttendanceScroll", main, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 12, -72)
  scroll:SetPoint("BOTTOMRIGHT", -30, 96)
  main.content = CreateFrame("Frame", nil, scroll)
  main.content:SetSize(WIDTH - 50, 1)
  scroll:SetScrollChild(main.content)

  main.status = main:CreateFontString(nil, "OVERLAY", "ESAttendanceFontSmall")
  main.status:SetPoint("BOTTOMLEFT", 14, 78)
  main.status:SetPoint("BOTTOMRIGHT", -14, 78)
  main.status:SetJustifyH("LEFT")
  main.status:SetWordWrap(false)

  local row1 = -1
  local b1 = button(main, "Obnovit", 90, function() ns.RequestGuildRoster(); ns.ReadGuildRoster(); ns.ScanGroup() end)
  b1:SetPoint("BOTTOMLEFT", 12, 46)
  local b2 = button(main, "Pozvat chybějící", 130, function() ns.InviteMissing(false) end)
  b2:SetPoint("LEFT", b1, "RIGHT", 6, 0)
  local b3 = button(main, "Pozvat jen online", 130, function() ns.InviteMissing(true) end)
  b3:SetPoint("LEFT", b2, "RIGHT", 6, 0)
  main.cancelBtn = button(main, "Zrušit", 70, function() ns.CancelInvites() end)
  main.cancelBtn:SetPoint("LEFT", b3, "RIGHT", 6, 0)
  main.cancelBtn:Hide()

  local b4 = button(main, "Zapsat docházku", 140, function()
    local rec, info = ns.WriteAttendance()
    ns.Print(info)
    if rec then ns.ShowText("export", rec.export) end
  end)
  b4:SetPoint("BOTTOMLEFT", 12, 18)
  local b5 = button(main, "Export", 80, function()
    local rec = ns.LatestRecord()
    if rec then ns.ShowText("export", rec.export) else ns.Print("žádný záznam docházky") end
  end)
  b5:SetPoint("LEFT", b4, "RIGHT", 6, 0)
  local b6 = button(main, "Import rosteru", 120, function() ns.ShowText("import") end)
  b6:SetPoint("LEFT", b5, "RIGHT", 6, 0)

  main.lastRecord = main:CreateFontString(nil, "OVERLAY", "ESAttendanceFontSmall")
  main.lastRecord:SetPoint("LEFT", b6, "RIGHT", 8, 0)
  main.lastRecord:SetPoint("RIGHT", main, "RIGHT", -12, 0)
  main.lastRecord:SetJustifyH("LEFT")
  main.lastRecord:SetTextColor(0.55, 0.6, 0.57)

  main:SetScript("OnShow", function() ns.RequestGuildRoster(); ns.ReadGuildRoster(); ns.ScanGroup(); refreshList() end)
  main:Hide()   -- CreateFrame returns a visible frame; Toggle() decides when to show it
end

function ns.Toggle()
  if not main then createMain() end
  if main:IsShown() then main:Hide() else main:Show() end
end

-- ---------------------------------------------------------------- text dialog
--- Pasted roster text loads itself (import mode). Returns true when the text was a roster.
local function tryImport(text)
  if textMode ~= "import" or importing then return false end
  if not (text:match("^%s*ESROSTER;") and text:find("\n", 1, true)) then return false end
  importing = true
  local ok, msg = ns.ImportRoster(text)
  ns.Print(msg)
  textFrame.status:SetText((ok and "|cff3fd68a" or "|cffff5555") .. msg .. "|r")
  if ok then refreshList() end
  importing = false
  return true
end

local function createTextFrame()
  textFrame = CreateFrame("Frame", "ESAttendanceTextFrame", UIParent, "BackdropTemplate")
  textFrame:SetSize(560, 380)
  textFrame:SetPoint("CENTER", 0, 40)
  textFrame:SetFrameStrata("DIALOG")
  textFrame:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
    edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", tile = true, tileSize = 16, edgeSize = 16,
    insets = { left = 4, right = 4, top = 4, bottom = 4 } })
  textFrame:SetBackdropColor(0.04, 0.05, 0.045, 0.97)
  textFrame:SetBackdropBorderColor(0.25, 0.84, 0.54, 0.9)
  textFrame:SetMovable(true)
  textFrame:EnableMouse(true)
  textFrame:RegisterForDrag("LeftButton")
  textFrame:SetScript("OnDragStart", textFrame.StartMoving)
  textFrame:SetScript("OnDragStop", textFrame.StopMovingOrSizing)
  tinsert(UISpecialFrames, "ESAttendanceTextFrame")
  textFrame:Hide()

  textFrame.title = textFrame:CreateFontString(nil, "OVERLAY", "ESAttendanceFontLarge")
  textFrame.title:SetPoint("TOPLEFT", 14, -12)
  textFrame.hint = textFrame:CreateFontString(nil, "OVERLAY", "ESAttendanceFontSmall")
  textFrame.hint:SetPoint("TOPLEFT", 14, -34)
  textFrame.hint:SetPoint("TOPRIGHT", -14, -34)
  textFrame.hint:SetJustifyH("LEFT")

  local close = CreateFrame("Button", nil, textFrame, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -4, -4)

  -- URL row: ready-made link to copy into the browser (roster text / attendance form)
  textFrame.urlLabel = textFrame:CreateFontString(nil, "OVERLAY", "ESAttendanceFontNormalSmall")
  textFrame.urlLabel:SetPoint("TOPLEFT", 14, -62)
  textFrame.urlLabel:SetText("URL:")
  local urlBox = CreateFrame("EditBox", nil, textFrame, "InputBoxTemplate")
  urlBox:SetHeight(20)
  urlBox:SetPoint("LEFT", textFrame.urlLabel, "RIGHT", 10, 0)
  urlBox:SetPoint("RIGHT", textFrame, "RIGHT", -120, 0)
  urlBox:SetAutoFocus(false)
  urlBox:SetFontObject(ESAttendanceFontSmall)
  urlBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
  urlBox:SetScript("OnEnterPressed", function(self) self:ClearFocus() end)
  urlBox:SetScript("OnEditFocusGained", function(self) self:HighlightText() end)
  urlBox:SetScript("OnTextChanged", function(self, user)
    if not user then return end
    -- read-only box: typing/pasting restores the URL; a pasted roster is imported anyway
    local pasted = self:GetText()
    self:SetText(self.url or "")
    self:HighlightText()
    if tryImport(pasted) then textFrame.edit:SetText(pasted) end
  end)
  textFrame.urlBox = urlBox
  textFrame.urlBtn = button(textFrame, "Kopírovat URL", 100, function() urlBox:SetFocus(); urlBox:HighlightText() end)
  textFrame.urlBtn:SetPoint("LEFT", urlBox, "RIGHT", 6, 0)

  local scroll = CreateFrame("ScrollFrame", "ESAttendanceTextScroll", textFrame, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 14, -90)
  scroll:SetPoint("BOTTOMRIGHT", -32, 44)
  local bg = textFrame:CreateTexture(nil, "BACKGROUND")
  bg:SetPoint("TOPLEFT", scroll, -4, 4)
  bg:SetPoint("BOTTOMRIGHT", scroll, 4, -4)
  bg:SetColorTexture(0, 0, 0, 0.5)

  local edit = CreateFrame("EditBox", nil, scroll)
  edit:SetMultiLine(true)
  edit:SetFontObject(ChatFontNormal)
  edit:SetWidth(500)
  edit:SetAutoFocus(false)
  edit:SetMaxLetters(0)
  edit:SetScript("OnEscapePressed", function() textFrame:Hide() end)
  edit:SetScript("OnTextChanged", function(self, user)
    scroll:UpdateScrollChildRect()
    -- import mode: a pasted roster loads itself, no button needed
    if user then tryImport(self:GetText()) end
  end)
  scroll:SetScrollChild(edit)
  textFrame.edit = edit
  scroll:EnableMouse(true)
  scroll:SetScript("OnMouseDown", function() edit:SetFocus() end)

  textFrame.action = button(textFrame, "Načíst roster", 140, function()
    local ok, msg = ns.ImportRoster(edit:GetText())
    ns.Print(msg)
    textFrame.status:SetText((ok and "|cff3fd68a" or "|cffff5555") .. msg .. "|r")
    if ok then refreshList() end
  end)
  textFrame.action:SetPoint("BOTTOMLEFT", 14, 14)
  textFrame.selectBtn = button(textFrame, "Označit vše", 110, function() edit:SetFocus(); edit:HighlightText() end)
  textFrame.selectBtn:SetPoint("BOTTOMLEFT", 14, 14)
  textFrame.status = textFrame:CreateFontString(nil, "OVERLAY", "ESAttendanceFontSmall")
  textFrame.status:SetPoint("LEFT", textFrame.action, "RIGHT", 10, 0)
  textFrame.status:SetPoint("RIGHT", textFrame, "RIGHT", -14, 0)
  textFrame.status:SetJustifyH("LEFT")
end

--- mode "export": shows text, selected – Ctrl+C. mode "import": paste roster, "Načíst roster".
function ns.ShowText(mode, text)
  if not textFrame then createTextFrame() end
  textFrame.status:SetText("")
  textMode = mode
  if mode == "import" then
    textFrame.title:SetText("Import rosteru")
    textFrame.hint:SetText("1) Kopírovat URL → otevři ji v prohlížeči (stránka roster sama zkopíruje)  2) sem Ctrl+V – roster se načte hned.")
    textFrame.urlBox.url = ns.RosterUrl()
    textFrame.edit:SetText("")
    textFrame.action:Show()
    textFrame.selectBtn:Hide()
  else
    textFrame.title:SetText("Export")
    textFrame.hint:SetText("Text je označený – Ctrl+C, pak Kopírovat URL → formulář docházky v prohlížeči → Ctrl+V. (Nebo po /reload spusť sync_attendance.bat.)")
    textFrame.urlBox.url = ns.AttendanceUrl()
    textFrame.edit:SetText(text or "")
    textFrame.action:Hide()
    textFrame.selectBtn:Show()
  end
  textFrame.urlBox:SetText(textFrame.urlBox.url)
  textFrame.urlBox:SetCursorPosition(0)
  textFrame:Show()
  if mode == "import" then
    -- the first thing to grab is the URL, so preselect it
    textFrame.urlBox:SetFocus()
    textFrame.urlBox:HighlightText()
  else
    textFrame.edit:SetFocus()
    textFrame.edit:HighlightText()
  end
end

ns.callbacks[#ns.callbacks + 1] = function(event)
  if event == "GROUP" or event == "GUILD" or event == "ROSTER" or event == "INVITES" or event == "RECORD" then refreshList() end
end
