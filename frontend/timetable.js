<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Super Position — Timetable</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <div class="brand">
        <div class="badge">Super Position</div>
        <h1>Timetable</h1>
        <p class="subtitle">View schedules by person (availability + preference)</p>
      </div>
      <div class="card-actions">
        <button id="btnBack" class="ghost">← Back</button>
        <button id="btnDownload" class="primary" disabled>시간표 다운로드 (CSV)</button>
      </div>
    </header>

    <section class="card">
      <div class="card-head">
        <h2>Day</h2>
      </div>
      <div id="dayTabs" class="tabs"></div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Grid</h2>
      </div>

      <div id="emptyState" class="muted" style="display:none;">
        데이터가 없습니다. 메인 페이지에서 랜덤 생성 또는 CSV 로드를 먼저 진행하세요.
      </div>

      <div id="gridWrap" class="gridwrap" style="display:none;"></div>

      <div class="inline-note" style="margin-top:12px;">
        <b>색상:</b>
        흰색=가능, 회색=불가, <span style="background:var(--y); padding:2px 6px; border-radius:8px; border:1px solid rgba(27,27,31,.12);">노랑</span>=선호(해당 슬롯 시작)
      </div>
    </section>
  </div>

  <script src="timetable.js"></script>
</body>
</html>