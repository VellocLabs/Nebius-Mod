---
# Welcome page for the `nebius:safecode` type - de variant. See `welcome.md` for
# the structure; only user-visible values are translated.
greeting: Woran möchtest du arbeiten?
suggestions:
  - title: Prüfen, ob meine Sandbox bereit ist
    description: Was noch fehlt und wer es erledigt.
    prompt: Prüfe, ob meine Nebius-Sandbox einsatzbereit ist. Führe die Einrichtungsprüfung aus, sag mir, was noch fehlt und wer welchen Schritt übernehmen muss, und erledige deinen Teil, sobald ich zustimme.
  - title: Synchronisieren und Tests ausführen
    description: Den Arbeitsbereich in eine Sandbox synchronisieren und dort die Testsuite ausführen.
    prompt: Synchronisiere diesen Arbeitsbereich in eine Nebius-Sandbox, führe dort die Testsuite des Projekts aus und berichte, was bestanden und was fehlgeschlagen ist, mit der relevanten Ausgabe. Führe auf diesem Rechner nichts aus.
  - title: Einen Bug beheben und in der Sandbox prüfen
    description: Hier lesen, hier ändern, die relevanten Tests in einer Sandbox ausführen.
    prompt: Untersuche diesen Bug, indem du den Code liest, finde die Ursache und nimm die kleinste zuverlässige Korrektur mit SuperEdit vor. Synchronisiere dann den Arbeitsbereich in eine Sandbox und führe dort die Tests aus, die die Änderung abdecken. Sag mir, was die Sandbox gezeigt hat und was du nicht prüfen konntest.
  - title: Im Web nachschlagen
    description: Dokumentation, eine Fehlermeldung, ein Changelog — über Tavily.
    prompt: Suche im Web nach dem, was hier gebraucht wird — die Dokumentation der Bibliothek, die genaue Fehlermeldung oder das Changelog der verwendeten Version —, lies die relevanten Seiten und sag mir mit Quellen, was hier zutrifft. Schlage dann die Änderung vor, falls sich eine ergibt.
  - title: Diese Codebasis verstehen
    description: Architektur, Module und wichtige Abläufe erkunden.
    prompt: Hilf mir, diese Codebasis zu verstehen, indem du sie liest. Finde die Hauptkomponenten, wichtigen Einstiegspunkte, den Datenfluss und die Teile, die ich zuerst lesen sollte.
  - title: Code prüfen
    description: Bugs, Risiken und Verbesserungsmöglichkeiten finden.
    prompt: Prüfe diesen Code durch Lesen auf Korrektheit, Bugs, Regressionen, Sicherheitsrisiken, Performance-Probleme und Wartbarkeit. Stelle die wichtigsten Funde nach vorn. Wenn ein Fund zum Bestätigen einen Lauf braucht, sag es und biete an, ihn in einer Sandbox zu bestätigen.
---
