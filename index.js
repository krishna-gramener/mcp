import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";

const server = new McpServer({
  name: "variantToPhenotype",
  version: "1.0.0",
});

async function variantToPhenotypeExploration(variant) {
  try {
    let hgvsFormat = variant;

    // Step 1: Convert cDNA format to Genomic HGVS if needed
    if (variant.includes("c.")) {
      // If input is in cDNA format
      console.log(`Converting cDNA notation to HGVS: ${variant}`);
      hgvsFormat = await convertGeneToHGVS(variant);
    }

    if (!hgvsFormat || hgvsFormat.error) {
      return { error: "Failed to convert variant to HGVS format" };
    }

    console.log(`Using HGVS format: ${hgvsFormat}`);

    // Step 1: Convert HGVS to Genomic Coordinates
    const genomicCoords = await convertHGVS(hgvsFormat);

    // Step 2: Get Gene Annotations from UCSC
    const geneAnnotations = await fetchGeneAnnotations(genomicCoords);

    // Step 3: Get Conservation Scores
    const conservationScores = await fetchConservationScores(genomicCoords);

    // Step 4: Get Known SNPs
    const knownSNPs = await fetchKnownSNPs(genomicCoords);

    // Step 5: Compile Final Response
    return {
      hgvs,
      genomicCoords,
      geneAnnotations,
      conservationScores,
      knownSNPs,
    };
  } catch (error) {
    console.error("Error in variant exploration:", error.message);
    return { error: "Failed to process variant" };
  }
}

// 1️⃣ Convert HGVS to Genomic Coordinates (Different Implementation)
async function convertHGVS(hgvs) {
  const ensemblUrl = `https://rest.ensembl.org/variant/lookup/${hgvs}?content-type=application/json`;

  try {
    const response = await axios.get(ensemblUrl);
    return response.data; // Example: { "seq_region_name": "chr17", "start": 43045760, "end": 43045760 }
  } catch (error) {
    console.error("Error fetching coordinates:", error.message);
    return { error: "Failed to fetch genomic coordinates" };
  }
}

// 2️⃣ Fetch Gene Annotations from UCSC (Different Implementation)
async function fetchGeneAnnotations(coords) {
  const { seq_region_name, start, end } = coords;

  try {
    const ucscUrl = `https://api.genome.ucsc.edu/getData/track?genome=hg38;track=knownGene;chrom=${seq_region_name};start=${start};end=${end}`;
    const response = await axios.get(ucscUrl);

    return response.data || { error: "No gene annotations found" };
  } catch (error) {
    console.error("Error fetching gene annotations:", error.message);
    return { error: "Failed to fetch gene annotations" };
  }
}

// 3️⃣ Fetch Conservation Scores (Different Implementation)
async function fetchConservationScores(coords) {
  const { seq_region_name, start, end } = coords;

  try {
    const conservationUrl = `https://api.genome.ucsc.edu/getData/track?genome=hg38;track=phastCons100way;chrom=${seq_region_name};start=${start};end=${end}`;
    const response = await axios.get(conservationUrl);

    return response.data || { error: "No conservation scores found" };
  } catch (error) {
    console.error("Error fetching conservation scores:", error.message);
    return { error: "Failed to fetch conservation scores" };
  }
}

// 4️⃣ Fetch Known SNPs (Different Implementation)
async function fetchKnownSNPs(coords) {
  const { seq_region_name, start, end } = coords;

  try {
    const snpUrl = `https://api.genome.ucsc.edu/getData/track?genome=hg38;track=snp151;chrom=${seq_region_name};start=${start};end=${end}`;
    const response = await axios.get(snpUrl);

    return response.data || { error: "No known SNPs found" };
  } catch (error) {
    console.error("Error fetching SNPs:", error.message);
    return { error: "Failed to fetch SNP data" };
  }
}

async function convertGeneToHGVS(variant) {
  try {
    console.log(`Processing variant: ${variant}`);
    
    let gene, cdnaVariant;
    
    // Handle both "GENE:c.MUTATION" and "GENE c.MUTATION" formats
    if (variant.includes(":")) {
      [gene, cdnaVariant] = variant.split(":");
    } else if (variant.includes(" ")) {
      [gene, cdnaVariant] = variant.split(" ");
    } else {
      console.error("Invalid variant format. Expected 'GENE:c.MUTATION' or 'GENE c.MUTATION'");
      return { error: "Invalid variant format. Expected 'GENE:c.MUTATION' or 'GENE c.MUTATION'" };
    }
    
    if (!gene || !cdnaVariant) {
      console.error("Failed to parse gene or cDNA variant");
      return { error: "Failed to parse gene or cDNA variant" };
    }

    // Step 1: Get Transcript ID for the Gene from Ensembl
    const ensemblUrl = `https://rest.ensembl.org/lookup/symbol/homo_sapiens/${gene}?expand=1`;
    console.log(`Fetching from Ensembl: ${ensemblUrl}`);
    
    const geneResponse = await axios.get(ensemblUrl, { headers: { "Content-Type": "application/json" } });

    if (!geneResponse.data || !geneResponse.data.id) {
      console.error("Gene not found in Ensembl");
      return { error: "Gene not found in Ensembl" };
    }

    const transcripts = geneResponse.data.Transcript;
    
    if (!transcripts || transcripts.length === 0) {
      console.error("No transcripts found for gene");
      return { error: "No transcripts found for gene" };
    }

    // Select canonical transcript if available, otherwise pick the first one
    const canonicalTranscript = transcripts.find(t => t.is_canonical) || transcripts[0];
    const transcriptId = canonicalTranscript.id;
    
    console.log(`Using transcript ID: ${transcriptId}`);

    // Step 2: Use Variant Recoder API to Convert cDNA to HGVS Genomic Notation
    const recoderUrl = `https://rest.ensembl.org/variant_recoder/human/${transcriptId}:${cdnaVariant}`;
    console.log(`Fetching from Variant Recoder: ${recoderUrl}`);
    
    const recoderResponse = await axios.get(recoderUrl, { headers: { "Content-Type": "application/json" } });

    if (!recoderResponse.data || recoderResponse.data.length === 0) {
      console.error("No data returned from Variant Recoder");
      return { error: "No data returned from Variant Recoder" };
    }

    const variantData = recoderResponse.data[0];

    if (variantData.hgvsg) {
      console.log(`Successfully converted to HGVS Genomic: ${variantData.hgvsg}`);
      return { hgvs: variantData.hgvsg };
    } else if (variantData.hgvs) {
      console.log(`Successfully converted to HGVS: ${variantData.hgvs}`);
      return { hgvs: variantData.hgvs };
    } else {
      console.error("Failed to retrieve HGVS notation");
      return { error: "Failed to retrieve HGVS notation" };
    }
  } catch (error) {
    console.error("Error converting gene to HGVS:", error.message);
    return { error: `Failed to process gene variant conversion: ${error.message}` };
  }
}

server.tool(
  "variantToPhenotypeExploration",
  { variant: z.string() },
  async ({ variant }) => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(await variantToPhenotypeExploration(variant)),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Variant-to-phenotype MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
