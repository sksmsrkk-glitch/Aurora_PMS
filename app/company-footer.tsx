/** Legal operator information shared by every Talos PMS and public booking view. */
export default function CompanyFooter({
  compact = false,
  showPmsLogin = false,
}: {
  compact?: boolean;
  showPmsLogin?: boolean;
}) {
  return (
    <footer className={`allmytour-footer${compact ? " compact" : ""}`}>
      <div className="allmytour-footer-title">
        <strong>주식회사 올마이투어</strong>
        <span className="talos-wordmark">Talos PMS 운영사</span>
      </div>
      <div className="allmytour-footer-details">
        <span>대표이사 석영규 · 정현일</span>
        <address>서울특별시 종로구 창경궁로 112-7 1101</address>
        <a href="tel:16888376">1688-8376</a>
        <a href="mailto:talos@allmytour.com">talos@allmytour.com</a>
      </div>
      {showPmsLogin && <a className="allmytour-footer-login" href="/login">PMS 로그인</a>}
    </footer>
  );
}
