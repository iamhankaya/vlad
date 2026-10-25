# ponytail — kaynak notu

- Kaynak: github.com/DietrichGebert/ponytail (`skills/ponytail/SKILL.md`)
- Commit: `09c434ab73ca43761c5d8b0c5d341926c2fba710`
- Blob SHA (SKILL.md): `d64edd32265ba21cbf5270158f04e97d96925f27`
- Lisans: MIT (`LICENSE` bu dizinde)
- `SKILL.md` değiştirilmeden alındı. Plugin, hook'lar, komutlar ve diğer skill'ler (audit/debt/gain/review/help) alınmadı.
- Kullanım: yalnız `developer` ve `game-developer` rolleri, yalnız `full` seviye (T20261026-04). `.claude/skills` altında değil, `vendor/skills/ponytail/` altında: orada vlad reposundaki her session'da "any coding task" açıklamasıyla listelenirdi (F-vlad-065). Rol yükleyince worker prompt'u dosyanın yolunu verir (`splitSkills`, `src/roles/store.ts`); bulut prompt'una satır içi girer.
- Güncellemek için kaynaktan yeniden kopyala; blob SHA'yı ve `test/roles/repo-roles.test.ts`'teki sabiti güncelle.
