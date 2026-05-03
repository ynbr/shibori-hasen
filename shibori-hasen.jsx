#target illustrator

/*
  shibori-hasen.jsx  v0.2.0
  Illustrator JSX / ScriptUI modal dialog 版
  対応: Illustrator 30.x（macOS）

  - 選択パスを直線dashの集合に変換
  - モーダルdialogでパラメータ設定 → OKで一括変換
  - palette版で発生した macOS フォーカス問題を回避するためdialog方式
  - ライブプレビューは廃止。OK押下後に結果が表示される
  - 角あり閉パスでは、各頂点の直後を dash 開始、直前を gap として配置する
  - corner 判定はアンカー位置の折れ線角度ではなく、入出接線の角度差で行う
  - dash 同士が詰まりすぎないよう、内部の最小可視 gap を使って本数を選定する

  使い方:
    1. 破線化したいパスを選択
    2. File > Scripts > Other Script... で本ファイルを実行
    3. 数値・チェックボックスを調整して「OK」
    4. dashグループ "shibori-hasen-dashes" が生成され、元線は非表示
*/

(function () {
    if (app.documents.length === 0) {
        alert("ドキュメントが開かれていません。");
        return;
    }

    var doc = app.activeDocument;
    if (!doc.selection || doc.selection.length === 0) {
        alert("破線化したいパスを選択してください。");
        return;
    }

    var CONFIG = {
        targetDashMm: 7.0,
        targetGapMm: 2.0,
        // Illustrator の DOM 座標は常に point 単位（ルーラー設定によらず固定）。
        // 1pt = 25.4mm / 72 ≒ 0.35278mm。UI からは編集させない（環境非依存の定数）。
        unitToMm: 0.35278,
        roundCapCorrection: true,
        useRoundCap: true,

        minDashLength: 0.35,
        sampleStep: 0.08,

        useAnchorCornerDetection: true,
        anchorCornerAngle: 25,
        skipDashAcrossAnchorCorner: true,
        minVisibleGapMm: 1.2,
        minVisibleGapRatio: 0.8,

        // 閉じたパスかつアンカー角が一切ない場合のみ両端に半gapマージンを置き、
        // wraparound での dash 連結を防ぐ。アンカー角を持つセグメントでは
        // 境界（=頂点）に dash を接触させる。UI には露出しない内部定数。
        straightDash: true,

        hideOriginal: true,
        deleteOriginal: false,

        finalGroupName: "shibori-hasen-dashes",
        showReport: true
    };

    var originalSelection = [];
    for (var si = 0; si < doc.selection.length; si++) {
        originalSelection.push(doc.selection[si]);
    }

    // -------- UI: modal dialog --------
    var win = new Window("dialog", "絞り破線ジェネレーター");
    win.orientation = "column";
    win.alignChildren = "fill";
    win.spacing = 8;
    win.margins = 12;

    addTitle(win, "基本設定");
    var dashCtl = addSliderRow(win, "破線長 mm", CONFIG.targetDashMm, 1, 20, 2);
    var gapCtl = addSliderRow(win, "間隔 mm", CONFIG.targetGapMm, 0.1, 10, 2);
    var minCtl = addSliderRow(win, "minDash unit", CONFIG.minDashLength, 0.05, 2.0, 2);

    addTitle(win, "角処理");
    var anchorAngleCtl = addSliderRow(win, "anchor角度", CONFIG.anchorCornerAngle, 1, 120, 0);
    var useAnchorChk = win.add("checkbox", undefined, "アンカー角を検出する");
    useAnchorChk.value = CONFIG.useAnchorCornerDetection;
    var skipCornerChk = win.add("checkbox", undefined, "角をまたぐdashだけ描かない");
    skipCornerChk.value = CONFIG.skipDashAcrossAnchorCorner;

    addTitle(win, "線端・生成");
    var roundCapChk = win.add("checkbox", undefined, "線端を丸くする");
    roundCapChk.value = CONFIG.useRoundCap;
    var roundCorrectionChk = win.add("checkbox", undefined, "丸端補正を使う");
    roundCorrectionChk.value = CONFIG.roundCapCorrection;
    var hideOriginalChk = win.add("checkbox", undefined, "確定時に元線を非表示にする");
    hideOriginalChk.value = CONFIG.hideOriginal;

    var btnGroup = win.add("group");
    btnGroup.orientation = "row";
    btnGroup.alignChildren = "fill";
    var cancelBtn = btnGroup.add("button", undefined, "キャンセル", { name: "cancel" });
    var okBtn = btnGroup.add("button", undefined, "OK", { name: "ok" });

    if (win.show() !== 1) {
        return;
    }

    // -------- run --------
    readUIIntoConfig();

    if (!ensureDocReady()) return;

    var report = generateDashes(originalSelection);
    try { app.redraw(); } catch (e) {}

    if (report.errors && report.errors.length > 0) {
        alert("処理中にエラーが発生しました:\n" + report.errors.join("\n"));
    }

    if (report.created === 0) {
        alert(
            "dashが1本も生成できませんでした。\n\n" +
            "考えられる原因:\n" +
            "・パスが短すぎる\n" +
            "・角検出によって全dashがskipされた\n" +
            "・アクティブレイヤがロック/非表示\n\n" +
            "処理したパス: " + report.paths + " / skipped: " + report.skipped
        );
        return;
    }

    if (CONFIG.showReport) {
        alert(
            "破線化が完了しました。\n\n" +
            "処理したパス: " + report.paths + "\n" +
            "生成したdash: " + report.created + "\n" +
            "短すぎてスキップ: " + report.skipped + "\n" +
            "元線を保持: " + report.keptOriginal
        );
    }

    // ====================================================================
    // 以下、関数定義
    // ====================================================================

    function readUIIntoConfig() {
        CONFIG.targetDashMm = parseFloatSafe(dashCtl.input.text, CONFIG.targetDashMm);
        CONFIG.targetGapMm = parseFloatSafe(gapCtl.input.text, CONFIG.targetGapMm);
        CONFIG.minDashLength = parseFloatSafe(minCtl.input.text, CONFIG.minDashLength);
        CONFIG.anchorCornerAngle = parseFloatSafe(anchorAngleCtl.input.text, CONFIG.anchorCornerAngle);
        CONFIG.useAnchorCornerDetection = useAnchorChk.value;
        CONFIG.skipDashAcrossAnchorCorner = skipCornerChk.value;
        CONFIG.useRoundCap = roundCapChk.value;
        CONFIG.roundCapCorrection = roundCorrectionChk.value;
        CONFIG.hideOriginal = hideOriginalChk.value;

        if (CONFIG.targetDashMm <= 0) CONFIG.targetDashMm = 7.0;
        if (CONFIG.targetGapMm < 0) CONFIG.targetGapMm = 2.0;
        if (CONFIG.minDashLength < 0.01) CONFIG.minDashLength = 0.01;
        if (CONFIG.sampleStep <= 0) CONFIG.sampleStep = 0.08;
    }

    function ensureDocReady() {
        var layer = null;
        try { layer = doc.activeLayer; } catch (e) {}
        if (!layer) {
            alert("アクティブレイヤを取得できませんでした。");
            return false;
        }
        if (layer.locked) {
            alert("アクティブレイヤ「" + layer.name + "」がロックされています。\nロックを解除してから実行してください。");
            return false;
        }
        if (!layer.visible) {
            alert("アクティブレイヤ「" + layer.name + "」が非表示です。\n表示状態に戻してから実行してください。");
            return false;
        }
        return true;
    }

    function addTitle(parent, label) {
        var t = parent.add("statictext", undefined, label);
        try { t.graphics.font = ScriptUI.newFont(t.graphics.font.name, "BOLD", t.graphics.font.size); } catch (e) {}
        return t;
    }

    function addNumberRow(parent, label, defaultValue, decimals) {
        var g = parent.add("group");
        g.orientation = "row";
        g.alignChildren = ["left", "center"];

        var st = g.add("statictext", undefined, label);
        st.preferredSize.width = 95;

        var input = g.add("edittext", undefined, formatNumber(defaultValue, decimals));
        input.characters = 8;

        return { group: g, input: input };
    }

    function addSliderRow(parent, label, defaultValue, minValue, maxValue, decimals) {
        var g = parent.add("group");
        g.orientation = "row";
        g.alignChildren = ["left", "center"];

        var st = g.add("statictext", undefined, label);
        st.preferredSize.width = 95;

        var slider = g.add("slider", undefined, defaultValue, minValue, maxValue);
        slider.preferredSize.width = 140;

        var input = g.add("edittext", undefined, formatNumber(defaultValue, decimals));
        input.characters = 6;

        slider.onChanging = function () {
            input.text = formatNumber(slider.value, decimals);
        };
        slider.onChange = function () {
            input.text = formatNumber(slider.value, decimals);
        };
        input.onChange = function () {
            var v = parseFloatSafe(input.text, defaultValue);
            if (v < minValue) v = minValue;
            if (v > maxValue) v = maxValue;
            slider.value = v;
            input.text = formatNumber(v, decimals);
        };

        return { group: g, slider: slider, input: input };
    }

    function generateDashes(items) {
        var report = { paths: 0, created: 0, skipped: 0, keptOriginal: 0, errors: [] };

        var group = null;
        try {
            group = doc.groupItems.add();
            group.name = CONFIG.finalGroupName;
        } catch (eGrp) {
            report.errors.push("groupItems.add 失敗: " + eGrp);
            return report;
        }

        for (var i = 0; i < items.length; i++) {
            try {
                processItem(items[i], group, report);
            } catch (eItem) {
                report.errors.push("processItem[" + i + "] 失敗: " + eItem);
            }
        }

        if (report.created === 0) {
            try { group.remove(); } catch (e) {}
        }
        return report;
    }

    function processItem(item, group, report) {
        if (!item) return;
        if (item.typename === "PathItem") {
            processPathItem(item, group, report);
        } else if (item.typename === "CompoundPathItem") {
            var paths = [];
            for (var i = 0; i < item.pathItems.length; i++) paths.push(item.pathItems[i]);
            var before = report.created;
            for (i = 0; i < paths.length; i++) processPathItem(paths[i], group, report);
            if (report.created > before) hideOrDelete(item);
        } else if (item.typename === "GroupItem") {
            if (item.name === CONFIG.finalGroupName) return;
            var children = [];
            for (var j = 0; j < item.pageItems.length; j++) children.push(item.pageItems[j]);
            var beforeGroup = report.created;
            for (j = 0; j < children.length; j++) processItem(children[j], group, report);
            if (report.created > beforeGroup) hideOrDelete(item);
        }
    }

    function processPathItem(pathItem, group, report) {
        if (!pathItem || pathItem.pathPoints.length < 2) return;
        if (pathItem.guides || pathItem.clipping) return;
        report.paths++;

        var sampled = samplePathItem(pathItem, CONFIG.sampleStep);
        if (sampled.length < 2) { report.skipped++; return; }

        computeArcLength(sampled);
        var totalLength = sampled[sampled.length - 1].s;
        if (totalLength < CONFIG.minDashLength) { report.skipped++; return; }
        var corners = [];
        if (CONFIG.useAnchorCornerDetection) {
            corners = detectAnchorCorners(pathItem, sampled);
        }

        var segments = [];
        if (corners.length > 0) {
            if (pathItem.closed) {
                segments = buildClosedCornerSegments(corners, totalLength);
            } else if (CONFIG.skipDashAcrossAnchorCorner) {
                segments = buildOpenCornerSegments(corners, totalLength);
            }
        }
        if (segments.length === 0) {
            segments.push({ start: 0, end: totalLength, mode: pathItem.closed ? "loop" : "open" });
        }

        var before = report.created;
        for (var i = 0; i < segments.length; i++) {
            drawDashedSegment(pathItem, sampled, segments[i], group, report, totalLength);
        }

        if (report.created > before) {
            hideOrDelete(pathItem);
        } else {
            report.keptOriginal++;
        }
    }

    function drawDashedSegment(originalPath, sampled, segment, group, report, totalLength) {
        var segmentLength = segment.end - segment.start;
        if (segmentLength < CONFIG.minDashLength) return 0;

        var dashLength = getEffectiveDashLength(originalPath);
        var gapLength = getEffectiveGapLength(originalPath);
        if (dashLength <= 0) return 0;

        // 半gapマージン方式（全セグメント共通）：
        //   dashLength は固定、gapLength（adjustedGap）を伸縮させて長さ整合。
        //   両端に adjGap/2 のマージンを置く → 隣接セグメントのマージンと合算
        //   して完全な gap が成立し、角・閉パスwraparound で dash 連結を防ぐ。
        //   ※「角の上に dash を乗せて綴じさせない」配置は直線 dash では実現
        //     困難（隣接 dash が完全接触する=綴じる）のため、安全側として
        //     角の手前で半 gap 引く方式に戻している。
        var sw = 0;
        try { sw = originalPath.strokeWidth || 0; } catch (eSw) {}
        // 視覚gapフロア: ユーザ指定の baseGap の半分、または絶対 0.5pt の大きい方。
        // round cap の場合 visible_gap = path_gap - sw なので、path 上の minGap は
        // visible フロア + sw とする。
        var minGap = getMinimumGapLength(sw);
        var adjustedGap;
        var dashCount;
        var step;
        var s;
        var sideMargin;

        if (segment.mode === "loop") {
            dashCount = chooseDashCount(segmentLength, dashLength, gapLength, minGap, true);
            if (dashCount < 1) return 0;

            if (dashCount === 1) {
                adjustedGap = 0;
                sideMargin = Math.max(0, (segmentLength - dashLength) / 2);
            } else {
                var slot = segmentLength / dashCount;
                adjustedGap = slot - dashLength;
                if (adjustedGap < 0) adjustedGap = 0;
                sideMargin = adjustedGap / 2;
            }
            s = segment.start + sideMargin;
            step = dashLength + adjustedGap;
        } else {
            dashCount = chooseDashCountForMode(segmentLength, dashLength, gapLength, minGap, segment.mode);
            if (dashCount < 1) {
                if (startsWith(segment.mode, "dash_") && segmentLength >= dashLength) {
                    var fp0 = interpolateAtS(sampled, wrapS(segment.start, totalLength));
                    var fp1 = interpolateAtS(sampled, wrapS(segment.start + dashLength, totalLength));
                    if (fp0 && fp1) {
                        createDashPath(originalPath, [fp0, fp1], group, report);
                        return 1;
                    }
                }
                return 0;
            }

            if (segment.mode === "gap_gap") {
                adjustedGap = segmentLength / dashCount - dashLength;
                s = segment.start + adjustedGap / 2;
            } else if (segment.mode === "dash_dash") {
                adjustedGap = (segmentLength - dashCount * dashLength) / (dashCount - 1);
                s = segment.start;
            } else if (segment.mode === "dash_gap") {
                adjustedGap = (segmentLength - dashCount * dashLength) / dashCount;
                s = segment.start;
            } else if (segment.mode === "gap_dash") {
                adjustedGap = (segmentLength - dashCount * dashLength) / (dashCount - 0.5);
                s = segment.start + adjustedGap / 2;
            } else {
                if (dashCount === 1) {
                    adjustedGap = 0;
                    sideMargin = Math.max(0, (segmentLength - dashLength) / 2);
                } else {
                    adjustedGap = (segmentLength - dashCount * dashLength) / (dashCount - 1);
                    sideMargin = Math.max(0, (segmentLength - (dashCount * dashLength + (dashCount - 1) * adjustedGap)) / 2);
                }
                s = segment.start + sideMargin;
            }
            step = dashLength + adjustedGap;
        }

        var createdCount = 0;
        for (var i = 0; i < dashCount; i++) {
            var dashStart = s;
            var dashEnd = s + dashLength;
            if (!originalPath.closed) {
                dashEnd = Math.min(dashEnd, totalLength);
            } else {
                dashStart = wrapS(dashStart, totalLength);
                dashEnd = wrapS(dashEnd, totalLength);
            }

            if (dashEnd - dashStart >= CONFIG.minDashLength) {
                var p0 = interpolateAtS(sampled, dashStart);
                var p1 = interpolateAtS(sampled, dashEnd);
                if (p0 && p1) {
                    createDashPath(originalPath, [p0, p1], group, report);
                    createdCount++;
                }
            }
            s += dashLength + adjustedGap;
        }
        return createdCount;
    }

    function buildClosedCornerSegments(corners, totalLength) {
        if (corners.length < 2) {
            return [{ start: 0, end: totalLength, mode: "loop" }];
        }
        var segments = [];
        for (var i = 0; i < corners.length; i++) {
            var start = corners[i].s;
            var end = corners[(i + 1) % corners.length].s;
            if (i === corners.length - 1) end += totalLength;
            segments.push({
                start: start,
                end: end,
                mode: "dash_gap"
            });
        }
        return segments;
    }

    function buildOpenCornerSegments(corners, totalLength) {
        var boundaries = [{ s: 0, isCorner: false }];
        for (var i = 0; i < corners.length; i++) boundaries.push({ s: corners[i].s, isCorner: true });
        boundaries.push({ s: totalLength, isCorner: false });

        var segments = [];
        for (i = 0; i < boundaries.length - 1; i++) {
            var startBoundary = boundaries[i];
            var endBoundary = boundaries[i + 1];
            segments.push({
                start: startBoundary.s,
                end: endBoundary.s,
                mode: (startBoundary.isCorner && endBoundary.isCorner) ? "gap_gap" : "open"
            });
        }
        return segments;
    }

    function chooseDashCountForMode(segmentLength, dashLength, gapLength, minGap, mode) {
        var ideal;
        if (mode === "dash_dash") {
            ideal = (segmentLength + gapLength) / (dashLength + gapLength);
        } else if (mode === "dash_gap") {
            ideal = segmentLength / (dashLength + gapLength);
        } else if (mode === "gap_dash") {
            ideal = (segmentLength + gapLength * 0.5) / (dashLength + gapLength);
        } else {
            ideal = segmentLength / (dashLength + gapLength);
        }

        var floorN = Math.max(1, Math.floor(ideal));
        var ceilN = Math.max(1, Math.ceil(ideal));
        var candidates = (floorN === ceilN) ? [floorN] : [floorN, ceilN];
        var bestN = -1;
        var bestDelta = Infinity;

        for (var i = 0; i < candidates.length; i++) {
            var n = candidates[i];
            if (n * dashLength > segmentLength + 0.0001) continue;

            var gap;
            if (mode === "dash_dash") {
                if (n === 1) continue;
                gap = (segmentLength - n * dashLength) / (n - 1);
            } else if (mode === "gap_gap") {
                gap = segmentLength / n - dashLength;
            } else if (mode === "dash_gap") {
                gap = (segmentLength - n * dashLength) / n;
            } else if (mode === "gap_dash") {
                gap = (segmentLength - n * dashLength) / (n - 0.5);
            } else {
                gap = (n === 1)
                    ? (segmentLength - dashLength)
                    : (segmentLength - n * dashLength) / (n - 1);
            }
            if (gap < minGap) continue;

            var delta = Math.abs(gap - gapLength);
            if (delta < bestDelta) {
                bestDelta = delta;
                bestN = n;
            }
        }
        return bestN;
    }

    function chooseDashCount(segmentLength, dashLength, gapLength, minGap, isLoop) {
        // セグメントに dash を何本入れるか決める。
        // isLoop=true:  両端に adjGap/2 マージン → n*(dash+gap)=L 想定で n を推定
        // isLoop=false: 両端の dash が境界に接する → n*dash+(n-1)*gap=L 想定
        // 候補のうち target gap に最も近く、minGap を満たすものを採用。
        if (segmentLength < dashLength + 0.0001) {
            return segmentLength >= CONFIG.minDashLength ? 1 : 0;
        }
        var patternLength = dashLength + gapLength;
        var ideal = isLoop
            ? segmentLength / patternLength
            : (segmentLength + gapLength) / patternLength;
        var floorN = Math.max(1, Math.floor(ideal));
        var ceilN = Math.max(1, Math.ceil(ideal));

        if (minGap == null) minGap = gapLength > 0 ? gapLength * 0.5 : 0;

        var bestN = -1;
        var bestDelta = Infinity;
        var candidates = (floorN === ceilN) ? [floorN] : [floorN, ceilN];
        for (var k = 0; k < candidates.length; k++) {
            var n = candidates[k];
            if (n * dashLength > segmentLength + 0.0001) continue;
            if (n === 1) {
                // 1本配置: gap適合度は計測不能。2本目を入れたら minGap 未満に
                // なる、または2本入らない場合のみ採用。
                var twoSlotGap = isLoop
                    ? segmentLength / 2 - dashLength
                    : (segmentLength - 2 * dashLength);
                if (twoSlotGap < minGap || 2 * dashLength > segmentLength + 0.0001) {
                    var delta1 = Math.abs((segmentLength - dashLength) - gapLength);
                    if (delta1 < bestDelta) { bestDelta = delta1; bestN = 1; }
                }
            } else {
                var g = isLoop
                    ? segmentLength / n - dashLength
                    : (segmentLength - n * dashLength) / (n - 1);
                if (g < minGap) continue; // dash が連結して見える
                var delta = Math.abs(g - gapLength);
                if (delta < bestDelta) { bestDelta = delta; bestN = n; }
            }
        }
        // どの候補も不適なら最後の砦として n=1
        if (bestN < 1) bestN = 1;
        return bestN;
    }

    function createDashPath(originalPath, points, group, report) {
        var dash = group.pathItems.add();
        dash.stroked = true;
        dash.filled = false;
        dash.closed = false;
        dash.strokeWidth = originalPath.strokeWidth;

        // グラデーション/パターンストロークでの色継承失敗時は黒RGBにフォールバック
        var colorAssigned = false;
        try {
            dash.strokeColor = originalPath.strokeColor;
            colorAssigned = true;
        } catch (e1) {}
        if (!colorAssigned) {
            try {
                var fallback = new RGBColor();
                fallback.red = 0; fallback.green = 0; fallback.blue = 0;
                dash.strokeColor = fallback;
            } catch (eFb) {}
        }

        try { dash.opacity = originalPath.opacity; } catch (e2) {}
        try {
            if (CONFIG.useRoundCap) {
                dash.strokeCap = StrokeCap.ROUNDENDCAP;
            } else {
                dash.strokeCap = StrokeCap.BUTTENDCAP;
            }
        } catch (e3) {}
        try { dash.strokeJoin = StrokeJoin.ROUNDENDJOIN; } catch (e4) {}
        dash.setEntirePath(pointsToArray(points));
        report.created++;
        return dash;
    }

    function samplePathItem(pathItem, step) {
        var points = [];
        var pps = pathItem.pathPoints;
        var count = pps.length;
        var closed = pathItem.closed;
        for (var i = 0; i < count; i++) {
            if (!closed && i === count - 1) break;
            var p0 = pps[i];
            var p1 = pps[(i + 1) % count];
            var a0 = toPoint(p0.anchor);
            var h1 = toPoint(p0.rightDirection);
            var h2 = toPoint(p1.leftDirection);
            var a1 = toPoint(p1.anchor);
            var estimate = distance(a0, h1) + distance(h1, h2) + distance(h2, a1);
            if (estimate < 0.1) estimate = distance(a0, a1);
            var n = Math.max(2, Math.ceil(estimate / step));
            for (var j = 0; j < n; j++) {
                var t = j / n;
                var pt = cubicBezier(a0, h1, h2, a1, t);
                points.push({ x: pt.x, y: pt.y, s: 0 });
            }
        }
        if (!closed) {
            var last = pps[count - 1];
            points.push({ x: last.anchor[0], y: last.anchor[1], s: 0 });
        } else if (points.length > 0) {
            points.push({ x: points[0].x, y: points[0].y, s: 0 });
        }
        return removeDuplicatePoints(points);
    }

    function detectAnchorCorners(pathItem, sampled) {
        var corners = [];
        var pps = pathItem.pathPoints;
        var count = pps.length;
        var closed = pathItem.closed;
        for (var i = 0; i < count; i++) {
            if (!closed && (i === 0 || i === count - 1)) continue;
            var prevIndex = i - 1;
            var nextIndex = i + 1;
            if (prevIndex < 0) prevIndex = count - 1;
            if (nextIndex >= count) nextIndex = 0;

            var prevAnchor = toPoint(pps[prevIndex].anchor);
            var currAnchor = toPoint(pps[i].anchor);
            var nextAnchor = toPoint(pps[nextIndex].anchor);
            var leftHandle = toPoint(pps[i].leftDirection);
            var rightHandle = toPoint(pps[i].rightDirection);

            var incoming = tangentFromLeft(prevAnchor, leftHandle, currAnchor);
            var outgoing = tangentFromRight(currAnchor, rightHandle, nextAnchor);
            var angle = angleBetween(incoming, outgoing);

            if (angle >= CONFIG.anchorCornerAngle) {
                var nearest = findNearestSamplePoint(sampled, currAnchor);
                corners.push({ s: nearest.s, type: "hard", angle: angle, source: "anchor" });
            }
        }
        return corners;
    }

    function interpolateAtS(points, targetS) {
        if (targetS <= 0) return { x: points[0].x, y: points[0].y };
        for (var i = 1; i < points.length; i++) {
            var p0 = points[i - 1];
            var p1 = points[i];
            if (p0.s <= targetS && targetS <= p1.s) {
                var d = p1.s - p0.s;
                var t = d === 0 ? 0 : (targetS - p0.s) / d;
                return { x: lerp(p0.x, p1.x, t), y: lerp(p0.y, p1.y, t) };
            }
        }
        var last = points[points.length - 1];
        return { x: last.x, y: last.y };
    }

    function computeArcLength(points) {
        points[0].s = 0;
        for (var i = 1; i < points.length; i++) {
            points[i].s = points[i - 1].s + distance(points[i - 1], points[i]);
        }
    }

    function hideOrDelete(item) {
        if (CONFIG.deleteOriginal) {
            try { item.remove(); } catch (e1) {}
        } else if (CONFIG.hideOriginal) {
            try { item.hidden = true; } catch (e2) {}
        }
    }

    function cubicBezier(p0, p1, p2, p3, t) {
        var mt = 1 - t;
        var mt2 = mt * mt;
        var t2 = t * t;
        return {
            x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
            y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y
        };
    }

    function removeDuplicatePoints(points) {
        if (points.length <= 1) return points;
        var result = [points[0]];
        for (var i = 1; i < points.length; i++) {
            if (distance(result[result.length - 1], points[i]) > 0.0001) result.push(points[i]);
        }
        return result;
    }

    function findNearestSamplePoint(sampled, target) {
        var nearest = sampled[0];
        var minDist = distance(sampled[0], target);
        for (var i = 1; i < sampled.length; i++) {
            var d = distance(sampled[i], target);
            if (d < minDist) {
                minDist = d;
                nearest = sampled[i];
            }
        }
        return nearest;
    }

    function tangentFromLeft(prevAnchor, leftHandle, anchor) {
        if (distance(leftHandle, anchor) > 0.0001) {
            return { x: anchor.x - leftHandle.x, y: anchor.y - leftHandle.y };
        }
        return { x: anchor.x - prevAnchor.x, y: anchor.y - prevAnchor.y };
    }

    function tangentFromRight(anchor, rightHandle, nextAnchor) {
        if (distance(rightHandle, anchor) > 0.0001) {
            return { x: rightHandle.x - anchor.x, y: rightHandle.y - anchor.y };
        }
        return { x: nextAnchor.x - anchor.x, y: nextAnchor.y - anchor.y };
    }

    function wrapS(value, totalLength) {
        if (totalLength === 0) return 0;
        var wrapped = value % totalLength;
        if (wrapped < 0) wrapped += totalLength;
        return wrapped;
    }

    function startsWith(text, prefix) {
        return String(text).indexOf(prefix) === 0;
    }

    function mmToUnit(mm) {
        return mm / CONFIG.unitToMm;
    }

    function getEffectiveDashLength(originalPath) {
        var baseDash = mmToUnit(CONFIG.targetDashMm);
        if (CONFIG.roundCapCorrection && CONFIG.useRoundCap) {
            return Math.max(CONFIG.minDashLength, baseDash - originalPath.strokeWidth);
        }
        return baseDash;
    }

    function getEffectiveGapLength(originalPath) {
        var baseGap = mmToUnit(CONFIG.targetGapMm);
        if (CONFIG.roundCapCorrection && CONFIG.useRoundCap) {
            return baseGap + originalPath.strokeWidth;
        }
        return baseGap;
    }

    function getMinimumGapLength(strokeWidth) {
        var baseGap = mmToUnit(CONFIG.targetGapMm);
        var minVisibleGap = Math.max(
            mmToUnit(CONFIG.minVisibleGapMm),
            baseGap * CONFIG.minVisibleGapRatio
        );
        return minVisibleGap + (CONFIG.useRoundCap ? strokeWidth : 0);
    }

    function toPoint(arr) { return { x: arr[0], y: arr[1] }; }

    function pointsToArray(points) {
        var arr = [];
        for (var i = 0; i < points.length; i++) arr.push([points[i].x, points[i].y]);
        return arr;
    }

    function distance(a, b) {
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function lerp(a, b, t) { return a + (b - a) * t; }

    function clamp(v, minValue, maxValue) { return Math.max(minValue, Math.min(maxValue, v)); }

    function angleBetween(v1, v2) {
        var len1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
        var len2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
        if (len1 === 0 || len2 === 0) return 0;
        var cosValue = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
        cosValue = clamp(cosValue, -1, 1);
        return Math.acos(cosValue) * 180 / Math.PI;
    }

    function parseFloatSafe(value, fallback) {
        var n = parseFloat(String(value).replace(",", "."));
        if (isNaN(n)) return fallback;
        return n;
    }

    function formatNumber(value, decimals) {
        var n = parseFloatSafe(value, 0);
        return n.toFixed(decimals);
    }
})();
