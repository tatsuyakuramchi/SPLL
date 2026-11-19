# SPLL 業務レーン図の生成：python3 docs/tools/gen_lane_diagram.py docs/SPLL_業務レーン図_v1.0.html
import html, sys
OUT=sys.argv[1]
LANES=['クリエーター','AWS（入口）','formrun・CloudSign','GAS（処理）','事務局（管理画面）','経理']
LW=128; CW=158; HH=34; LH=92; BW=112; BH=62
def cx(c): return LW+c*CW+CW/2
ROWS=list(range(len(LANES)))
def cy(l): return HH+ROWS.index(l)*LH+LH/2
def esc(s): return html.escape(s)

def figure(fid, cols, nodes, edges, title, caption, phases, rows):
    global ROWS
    ROWS=rows
    W=LW+cols*CW+8; H=HH+len(rows)*LH+4
    o=[f'<svg viewBox="0 0 {W} {H}" width="{W}" role="img" aria-label="{esc(caption)}" class="lane-svg">']
    o.append(f'<defs><marker id="ah-{fid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ahead"/></marker></defs>')
    # phase header bands
    for (c0,c1,label) in phases:
        x=LW+c0*CW; w=(c1-c0+1)*CW
        o.append(f'<rect x="{x+2}" y="4" width="{w-4}" height="{HH-10}" rx="4" class="phase"/>')
        o.append(f'<text x="{x+w/2}" y="{HH/2+3}" text-anchor="middle" class="phase-t">{esc(label)}</text>')
    for i,li in enumerate(rows):
        l=LANES[li]; y=HH+i*LH
        o.append(f'<rect x="0" y="{y}" width="{W}" height="{LH}" class="{"lane-a" if i%2==0 else "lane-b"}"/>')
        o.append(f'<line x1="0" y1="{y}" x2="{W}" y2="{y}" class="lane-line"/>')
        o.append(f'<text x="12" y="{y+LH/2+4}" class="lane-t">{esc(l)}</text>')
    o.append(f'<line x1="{LW}" y1="{HH}" x2="{LW}" y2="{H}" class="lane-line"/>')
    pos={}
    for n in nodes:
        pos[n['id']]=(n['c'],n['l'])
    # edges first (under nodes)
    for e in edges:
        a,b,label=e[0],e[1],e[2]; dashed=len(e)>3 and e[3]
        (c1,l1),(c2,l2)=pos[a],pos[b]
        cls='edge dashed' if dashed else 'edge'
        if c1==c2:
            x=cx(c1); y1=cy(l1)+(BH/2 if l2>l1 else -BH/2); y2=cy(l2)+(-BH/2 if l2>l1 else BH/2)
            o.append(f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{y2}" class="{cls}" marker-end="url(#ah-{fid})"/>')
            o.append(f'<text x="{x+5}" y="{(y1+y2)/2+4}" class="edge-t">{esc(label)}</text>')
        elif l1==l2:
            y=cy(l1); x1=cx(c1)+BW/2; x2=cx(c2)-BW/2
            o.append(f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" class="{cls}" marker-end="url(#ah-{fid})"/>')
            o.append(f'<text x="{(x1+x2)/2}" y="{y-6}" text-anchor="middle" class="edge-t">{esc(label)}</text>')
        else:
            x1=cx(c1)+BW/2; y1=cy(l1); x2=cx(c2)-BW/2; y2=cy(l2); xm=(x1+x2)/2
            o.append(f'<polyline points="{x1},{y1} {xm},{y1} {xm},{y2} {x2},{y2}" class="{cls}" fill="none" marker-end="url(#ah-{fid})"/>')
            ty=(y1+y2)/2+4
            o.append(f'<text x="{xm+5}" y="{ty}" class="edge-t">{esc(label)}</text>')
    for n in nodes:
        x=cx(n['c'])-BW/2; y=cy(n['l'])-BH/2; k=n.get('k','proc')
        lines=n['t'].split('\n')
        if k=='doc':
            f=12
            o.append(f'<path d="M{x} {y}H{x+BW-f}L{x+BW} {y+f}V{y+BH}H{x}Z" class="doc{" pending" if n.get("pending") else ""}"/>')
            o.append(f'<path d="M{x+BW-f} {y}V{y+f}H{x+BW}" class="doc-fold" fill="none"/>')
        elif k=='mail':
            o.append(f'<rect x="{x}" y="{y+6}" width="{BW}" height="{BH-12}" rx="6" class="mail"/>')
        else:
            o.append(f'<rect x="{x}" y="{y}" width="{BW}" height="{BH}" rx="6" class="node{" timed" if k=="timed" else ""}"/>')
            if k=='screen':
                o.append(f'<rect x="{x}" y="{y}" width="{BW}" height="7" rx="3" class="screen-band"/>')
        start=cy(n['l'])-(len(lines)-1)*7.5+4
        for i,t in enumerate(lines):
            cls='node-t'+(' doc-t' if k=='doc' else '')+(' b' if i==0 and k in('doc','timed') else '')
            o.append(f'<text x="{cx(n["c"])}" y="{start+i*15}" text-anchor="middle" class="{cls}">{esc(t)}</text>')
    o.append('</svg>')
    return f'<figure><h2>{esc(title)}</h2><div class="scroll">{"".join(o)}</div><figcaption>{esc(caption)}</figcaption></figure>'

A_nodes=[
 dict(id='n1',c=0,l=0,k='screen',t='入口サイトで\n制度の説明を読み\n同意する'),
 dict(id='n2',c=0,l=1,t='受付番号を発行\n（署名つき）\nGASは呼ばない'),
 dict(id='n3',c=1,l=0,k='screen',t='formrunで\n契約者情報を\n入力'),
 dict(id='n4',c=1,l=2,t='formrun→\nCloudSign\nテンプレート'),
 dict(id='d1',c=2,l=2,k='doc',t='① 利用許諾\n契約書\n（当事者欄のみ差込）'),
 dict(id='n5',c=2,l=0,k='screen',t='CloudSignで\n内容を確認し\n同意する'),
 dict(id='n6',c=3,l=1,t='締結Webhookを\n中継'),
 dict(id='n7',c=3,l=3,t='受信を記録して\nすぐ返す'),
 dict(id='n8',c=4,l=3,k='timed',t='定期実行（1分）\n書類を確認→\n契約番号・PDF'),
 dict(id='m1',c=4,l=0,k='mail',t='メール：\n専用ページの\nリンク'),
 dict(id='n9',c=5,l=0,k='screen',t='専用ページで\n作品を検索・選択\nして申込'),
 dict(id='n10',c=5,l=1,t='画面を配信\n作品一覧は\nキャッシュ'),
 dict(id='n11',c=5,l=3,t='受付表に記録\n（ロックなし）'),
 dict(id='n12',c=6,l=3,k='timed',t='定期実行（1分）\nSPLL番号・\n条件を確定'),
 dict(id='d2',c=7,l=3,k='doc',t='② 別紙PDF\n前払いは後ろに\n③ 請求書'),
 dict(id='n13',c=7,l=2,t='CloudSign APIで\n送信'),
 dict(id='n14',c=8,l=0,k='screen',t='CloudSignで\n別紙（＋請求書）\nに同意する'),
 dict(id='n15',c=8,l=3,t='同意Webhook\n照合コード確認\n本契約に追加'),
 dict(id='n16',c=9,l=3,t='前払い：入金待ち\n後払い：提出待ち'),
]
A_edges=[('n1','n2','開始'),('n2','n3','受付番号を\n渡して遷移'.replace('\n','')),('n3','n4','送信'),('n4','d1','作成'),('d1','n5','届く'),
 ('d1','n6','締結後'),('n6','n7','転送'),('n7','n8','1分ごと'),('n8','m1','送信'),('m1','n9','開く'),('n9','n10','申込'),('n10','n11','中継'),
 ('n11','n12','1分ごと'),('n12','d2','作成'),('d2','n13','添付'),('n13','n14','届く'),('n14','n15','同意'),('n15','n16','分岐')]
B_nodes=[
 dict(id='e1',c=0,l=5,t='入金CSVを\n出力'),
 dict(id='e2',c=1,l=4,k='screen',t='入金CSVを取込\n照合を確認して\n反映'),
 dict(id='e3',c=1,l=3,t='前払い：\n入金確認→\n提出待ち'),
 dict(id='e4',c=2,l=0,k='screen',t='提出ページで\n作品を提出'),
 dict(id='e5',c=2,l=1,t='画面を配信\nGASへ中継'),
 dict(id='e6',c=3,l=3,k='timed',t='定期実行\nAI一次審査'),
 dict(id='e7',c=4,l=4,k='screen',t='案件ボードで\n人手審査\n承認する'),
 dict(id='e8',c=5,l=3,t='認証を有効化\nバッジ生成\nジョブ'),
 dict(id='d4',c=6,l=3,k='doc',t='④ 認証バッジ\nQR→検証ページ'),
 dict(id='m2',c=6,l=0,k='mail',t='メール：\n審査完了・\nバッジ'),
 dict(id='e9',c=7,l=0,k='screen',t='専用ページで\nバッジを取得\n頒布物に表示'),
 dict(id='e10',c=8,l=3,k='timed',t='日次バッチ\n期限切れの取消\n期限超過の検出'),
 dict(id='e11',c=8,l=4,k='screen',t='要対応を確認\nS4で認証を\n一時停止'),
 dict(id='e12',c=9,l=5,t='電子書籍：\n配信会社から\n入金'),
 dict(id='d5',c=9,l=3,k='doc',pending=True,t='⑤ 精算書\n（相殺して残額）\n設計中'),
]
B_edges=[('e1','e2','受け渡し'),('e2','e3','反映'),('e3','e4','提出できる'),('e4','e5','提出'),('e5','e6','中継'),('e6','e7','指摘つき'),
 ('e7','e8','承認'),('e8','d4','発行'),('d4','m2','通知'),('m2','e9','開く'),('e10','e11','要対応'),('e12','d5','相殺',True)]
figA=figure('a',10,A_nodes,A_edges,'1. 利用許諾契約から別紙の同意まで',
 '入口とformrun・CloudSignの区間ではGASを呼ばない。GASは受信と受付を記録だけして、重い処理（契約番号の発行、別紙と請求書のPDF作成、CloudSignへの送信）は1分ごとの定期実行で行う。',
 [(0,2,'利用許諾契約の締結'),(3,4,'契約番号・専用ページ'),(5,9,'作品の選択と別紙')],[0,1,2,3])
figB=figure('b',10,B_nodes,B_edges,'2. 支払い・提出・審査・認証と、期限・精算',
 '前払いは入金CSVの取込で提出待ちへ進む。認証とバッジは支払方法にかかわらず審査の承認後にだけ出す。期限と後払いの未入金は日次バッチが要対応に出し、止めるのは事務局。電子書籍の精算書は設計中（破線）。',
 [(0,1,'前払いの入金'),(2,7,'提出・審査・認証'),(8,9,'期限・精算')],[0,1,3,4,5])

page=f'''<title>SPLL 業務レーン図</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Noto+Sans+JP:wght@400;500;700&display=swap">
<style>
/* Layout: 上から順に読む1列。レーン図2枚（横に長いので枠内スクロール）→ 画面一覧 → 文書の発行タイミング → システムの使い分け */
:root{{
  --bg:#f3f5f8; --panel:#ffffff; --ink:#18212c; --muted:#5b6674; --line:#d6dce3;
  --lane-a:#ffffff; --lane-b:#f6f8fa; --phase:#e6ecf2;
  --screen:#2f6fb0; --doc:#fdf0e1; --doc-line:#b0610f; --mail:#7a5aa8; --timed:#eef6f1; --timed-line:#2f7d55;
  --f-body:"Noto Sans JP",system-ui,"Hiragino Sans","Yu Gothic UI",sans-serif; --f-mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
}}
@media (prefers-color-scheme: dark){{ :root:not([data-theme="light"]){{
  --bg:#12171d; --panel:#1a2129; --ink:#e4e9ef; --muted:#9ba7b4; --line:#323b46;
  --lane-a:#1a2129; --lane-b:#1e262f; --phase:#26303b;
  --screen:#6aa7e6; --doc:#3a2a17; --doc-line:#f0a65a; --mail:#b39ae0; --timed:#1d2b24; --timed-line:#6cc497; color-scheme:dark }} }}
:root[data-theme="dark"]{{
  --bg:#12171d; --panel:#1a2129; --ink:#e4e9ef; --muted:#9ba7b4; --line:#323b46;
  --lane-a:#1a2129; --lane-b:#1e262f; --phase:#26303b;
  --screen:#6aa7e6; --doc:#3a2a17; --doc-line:#f0a65a; --mail:#b39ae0; --timed:#1d2b24; --timed-line:#6cc497; color-scheme:dark }}
body{{background:var(--bg);color:var(--ink);font-family:var(--f-body);line-height:1.6}}
.wrap>*{{min-width:0}}
.wrap{{max-width:1720px;margin:0 auto;padding-block:24px 48px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:28px}}
header h1{{font-size:22px;margin:0 0 4px;text-wrap:balance}}
header p{{margin:0;color:var(--muted);max-width:70ch}}
.legend{{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:13px;color:var(--muted);margin-top:12px}}
.legend span{{display:inline-flex;align-items:center;gap:6px}}
.sw{{display:inline-block;width:22px;height:14px;border-radius:3px;border:1.5px solid var(--line);background:var(--panel)}}
.sw.screen{{border-top:4px solid var(--screen)}} .sw.doc{{background:var(--doc);border-color:var(--doc-line)}} .sw.mail{{border:1.5px dashed var(--mail)}} .sw.timed{{background:var(--timed);border-color:var(--timed-line)}}
.sw.pending{{background:var(--doc);border:1.5px dashed var(--doc-line)}}
figure{{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;min-width:0}}
figure h2{{font-size:16px;margin:0 0 10px}}
figcaption{{font-size:13px;color:var(--muted);margin-top:10px;max-width:90ch}}
.scroll{{overflow-x:auto}}
.lane-svg{{display:block;max-width:none;height:auto;font-family:var(--f-body)}}
.lane-a{{fill:var(--lane-a)}} .lane-b{{fill:var(--lane-b)}} .lane-line{{stroke:var(--line);stroke-width:1}}
.lane-t{{fill:var(--ink);font-size:12.5px;font-weight:700}}
.phase{{fill:var(--phase)}} .phase-t{{fill:var(--muted);font-size:12px;font-weight:500;letter-spacing:.04em}}
.node{{fill:var(--panel);stroke:var(--ink);stroke-width:1.2}} .node.timed{{fill:var(--timed);stroke:var(--timed-line)}}
.screen-band{{fill:var(--screen)}}
.doc{{fill:var(--doc);stroke:var(--doc-line);stroke-width:1.6}} .doc.pending{{stroke-dasharray:5 4}} .doc-fold{{stroke:var(--doc-line);stroke-width:1.2}}
.mail{{fill:var(--panel);stroke:var(--mail);stroke-width:1.5;stroke-dasharray:5 4}}
.node-t{{fill:var(--ink);font-size:11.5px}} .node-t.b{{font-weight:700}} .doc-t{{fill:var(--ink)}}
.edge{{stroke:var(--muted);stroke-width:1.4;fill:none}} .edge.dashed{{stroke-dasharray:5 4}}
.ahead{{fill:var(--muted)}}
.edge-t{{fill:var(--muted);font-size:10.5px}}
section h2{{font-size:16px;margin:0 0 10px}}
.tbl{{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}}
table{{border-collapse:collapse;width:100%;min-width:720px;font-size:13.5px}}
th,td{{text-align:left;vertical-align:top;padding:9px 12px;border-top:1px solid var(--line)}}
thead th{{border-top:0;background:var(--lane-b);font-size:12px;color:var(--muted);font-weight:500;letter-spacing:.04em}}
td.k{{font-weight:500;white-space:nowrap}}
.badge{{display:inline-block;font-size:11px;padding:0 6px;border-radius:4px;border:1px solid var(--doc-line);color:var(--doc-line);margin-left:6px;white-space:nowrap}}
.mono{{font-family:var(--f-mono);font-size:12.5px}}
.note{{font-size:13px;color:var(--muted);margin:8px 2px 0}}
</style>
<div class="wrap">
<header>
  <h1>SPLL 業務レーン図</h1>
  <p>利用許諾契約の締結から認証バッジまでを、誰が・どの画面で・どのシステムを使い、どの時点でどの文書が出るかで並べた図です。左から右へ時間が進みます。</p>
  <div class="legend">
    <span><i class="sw screen"></i>クリエーター・事務局が操作する画面</span>
    <span><i class="sw"></i>システムの処理（すぐ返す）</span>
    <span><i class="sw timed"></i>定期実行・日次バッチ</span>
    <span><i class="sw doc"></i>発行される文書</span>
    <span><i class="sw pending"></i>設計中の文書</span>
    <span><i class="sw mail"></i>メール</span>
  </div>
</header>
{figA}
{figB}
<section>
  <h2>画面の一覧</h2>
  <div class="tbl"><table>
    <thead><tr><th>画面</th><th>置き場所</th><th>使う人</th><th>本人の確かめ方・データの出どころ</th></tr></thead>
    <tbody>
      <tr><td class="k">入口サイト（説明・同意）</td><td>AWS（CloudFront＋S3、受付番号は Lambda）</td><td>クリエーター</td><td>GAS を呼ばない。受付番号（署名つき）を formrun の隠し項目へ渡す</td></tr>
      <tr><td class="k">契約者情報の入力</td><td>formrun</td><td>クリエーター</td><td>氏名・住所・メールは formrun が受け取る。SPLL は締結後に CloudSign から氏名・メールだけを取る（住所は持たない）</td></tr>
      <tr><td class="k">契約書・別紙の確認と同意</td><td>CloudSign</td><td>クリエーター</td><td>利用許諾契約書はテンプレート、別紙と請求書は SPLL が作った PDF</td></tr>
      <tr><td class="k">専用ページ</td><td>AWS が配信、データは GAS</td><td>クリエーター</td><td>専用ページのトークン（登録メールにだけ送る長期リンク）。作品の選択・申込、別紙と状態の一覧、提出・バッジへの入口</td></tr>
      <tr><td class="k">提出ページ</td><td>AWS が配信、データは GAS</td><td>クリエーター</td><td>提出用トークン（専用ページから都度発行）。許諾が有効な案件だけ</td></tr>
      <tr><td class="k">検証ページ</td><td>AWS が配信、データは GAS</td><td>だれでも</td><td>バッジの QR。認証 ID と照合コード</td></tr>
      <tr><td class="k">案件ボード（管理画面）</td><td>GAS（社内ドメインのみ）</td><td>事務局・法務・審査</td><td>状態の一覧とステータススイッチ、入金CSVの取込</td></tr>
      <tr><td class="k">設定・事務局運営パネル</td><td>GAS（社内ドメインのみ）</td><td>事務局</td><td>料金表（支払方法）、法務文書、会議・議決・精算</td></tr>
    </tbody></table></div>
</section>
<section>
  <h2>文書の発行タイミング</h2>
  <div class="tbl"><table>
    <thead><tr><th>文書</th><th>いつ</th><th>作る</th><th>届け方</th><th>保管</th></tr></thead>
    <tbody>
      <tr><td class="k">① 利用許諾契約書</td><td>formrun の送信直後（クリエーター1人につき1回）</td><td>CloudSign のテンプレート（formrun が当事者欄を差し込む）</td><td>CloudSign</td><td>締結済み PDF を Drive に保存（GAS の定期実行）</td></tr>
      <tr><td class="k">② 別紙（許諾作品通知書）</td><td>専用ページの申込の後、1分ごとの定期実行で</td><td>GAS（申込時に確定した条件から）</td><td>CloudSign API。同意で本契約に追加</td><td>送信版と締結済み PDF、照合コード</td></tr>
      <tr><td class="k">③ 請求書<span class="badge">発行者は検討中</span></td><td>②と同時（前払いの別紙だけ。同じ PDF の後ろのページ）</td><td>GAS（請求書番号を採番）</td><td>②と同じ</td><td>②と同じ PDF、請求書番号を台帳へ</td></tr>
      <tr><td class="k">④ 認証バッジ・検証ページ</td><td>審査の承認後（支払方法にかかわらず）</td><td>GAS（バッジ生成ジョブ）</td><td>専用ページから取得、メールでお知らせ</td><td>Drive</td></tr>
      <tr><td class="k">⑤ 精算書（電子書籍・後払い）<span class="badge">設計中</span></td><td>配信会社からの入金の後（周期は未定）</td><td>未定</td><td>未定</td><td>未定</td></tr>
      <tr><td class="k">メール</td><td>契約番号の発行後：専用ページのリンク／審査の承認後：審査完了・バッジ</td><td>GAS</td><td>メール（口座情報は書かない）</td><td>通知の記録</td></tr>
    </tbody></table></div>
  <p class="note">③の発行者は「アークライトが各パートナーの代理として一括で発行（媒介者交付特例）」と「パートナーごとに発行」のどちらにするか検討中。</p>
</section>
<section>
  <h2>システムの使い分け</h2>
  <div class="tbl"><table>
    <thead><tr><th>システム</th><th>役割</th><th>この図での出番</th></tr></thead>
    <tbody>
      <tr><td class="k">AWS</td><td>入口だけ。画面の配信、GAS への中継（共有鍵・回数制限）、受付番号、Webhook の中継</td><td>入口サイト、専用ページ・提出・検証ページの配信、締結 Webhook の中継</td></tr>
      <tr><td class="k">formrun</td><td>契約者情報の入力</td><td>利用許諾契約の入力画面</td></tr>
      <tr><td class="k">CloudSign</td><td>契約書・別紙の送付と同意、締結の通知</td><td>①の締結、②③の同意</td></tr>
      <tr><td class="k">GAS（すぐ返す処理）</td><td>Webhook の受信記録、専用ページの表示内容、申込の受付</td><td>受信・受付の記録だけ（重い処理をしない）</td></tr>
      <tr><td class="k">GAS（定期実行・1分）</td><td>契約番号の発行、SPLL番号・条件の確定、別紙・請求書の PDF、CloudSign への送信、AI 一次審査、バッジ生成</td><td>図の緑の箱</td></tr>
      <tr><td class="k">GAS（日次バッチ）</td><td>3か月の期限切れの取消、後払いの期限超過、締結の照合（取りこぼし対策）</td><td>図の右端</td></tr>
      <tr><td class="k">スプレッドシート・Drive</td><td>台帳（契約・案件・受付・入金）と文書の保管</td><td>すべての処理の記録先</td></tr>
      <tr><td class="k">経理</td><td>入金CSVを出す。電子書籍の精算は設計中</td><td>前払いの入金、電子書籍の入金</td></tr>
    </tbody></table></div>
</section>
</div>
'''
open(OUT,'w',encoding='utf-8').write(page)
