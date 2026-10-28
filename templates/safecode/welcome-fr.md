---
# Welcome page for the `nebius:safecode` type - fr variant. See `welcome.md` for
# the structure; only user-visible values are translated.
greeting: Sur quoi voulez-vous travailler ?
suggestions:
  - title: Vérifier que mon bac à sable est prêt
    description: Ce qui manque encore, et qui s’en charge.
    prompt: Vérifie si mon bac à sable Nebius est prêt à l’emploi. Lance la vérification de configuration, dis-moi ce qui manque encore et qui doit faire chaque étape, puis fais ta part quand je suis d’accord.
  - title: Synchroniser et lancer les tests
    description: Synchroniser l’espace de travail dans un bac à sable et y lancer la suite de tests.
    prompt: Synchronise cet espace de travail dans un bac à sable Nebius, lances-y la suite de tests du projet et indique ce qui a réussi et ce qui a échoué, avec la sortie pertinente. N’exécute rien sur cet ordinateur.
  - title: Corriger un bug et vérifier dans un bac à sable
    description: Lire ici, modifier ici, lancer les tests concernés dans un bac à sable.
    prompt: Enquête sur ce bug en lisant le code, trouve la cause racine et applique la correction la plus petite et la plus fiable avec SuperEdit. Puis synchronise l’espace de travail dans un bac à sable et y lances les tests qui couvrent la modification. Dis-moi ce que le bac à sable a montré et ce que tu n’as pas pu vérifier.
  - title: Chercher sur le web
    description: Documentation, message d’erreur, journal des versions — via Tavily.
    prompt: Cherche sur le web ce dont cette tâche a besoin — la documentation de la bibliothèque, le message d’erreur exact ou le journal des versions utilisée —, lis les pages pertinentes et dis-moi ce qui s’applique ici, avec les sources. Propose ensuite la modification, si elle s’impose.
  - title: Comprendre ce code
    description: Explorer l’architecture, les modules et les flux importants.
    prompt: Aide-moi à comprendre ce code en le lisant. Identifie les composants principaux, les points d’entrée importants, le flux de données et les parties que je devrais lire en premier.
  - title: Relire le code
    description: Trouver les bugs, les risques et les pistes d’amélioration.
    prompt: Relis ce code, en le lisant, du point de vue de la correction, des bugs, des régressions, des risques de sécurité, des problèmes de performance et de la maintenabilité. Place les constats les plus importants en premier. Si un constat nécessite une exécution pour être confirmé, dis-le et propose de le confirmer dans un bac à sable.
---
