import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";

const server = new McpServer({ name: "variantToPhenotype", version: "1.0.0" });

// Function to extract HGVS notation from the query using LLM
async function extractHGVSFromQuery(query) {
  try {
    console.log("Extracting HGVS notation from query:", query);
    
    try {
      const llmApiUrl = "https://llmfoundry.straive.com/openai/v1/chat/completions";
      const response = await fetch(llmApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImtyaXNobmEua3VtYXJAZ3JhbWVuZXIuY29tIn0.QY0QNLADfGARpZvcew8DJgrtMtdxJ8NHUn9_qnSiWEM:mcp"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "You are a specialized assistant that extracts HGVS notations from text. Return ONLY the HGVS notation without any explanation or additional text."
            },
            {
              role: "user",
              content: `convert to the HGVS notation of the following : "${query}"`
            }
          ]
        })
      });
      
      const llmResponse = await response.json();
      console.log("LLM API response:", llmResponse);
      
      if (llmResponse && llmResponse.choices && llmResponse.choices.length > 0) {
        const extractedHgvs = llmResponse.choices[0].message.content.trim();
        console.log("LLM extracted HGVS:", extractedHgvs);
        return extractedHgvs;
      }
    } catch (llmError) {
      console.error("Error calling LLM API:", llmError);
      console.log("Function failed: Unable to extract HGVS notation");
      throw new Error("Failed to extract HGVS notation from query");
    }
    
    // If we reach here, the LLM call was successful but didn't return valid HGVS
    console.log("Function failed: LLM did not return a valid HGVS notation");
    throw new Error("Failed to extract HGVS notation from query");
  } catch (error) {
    console.error("Error extracting HGVS notation:", error);
    throw new Error("Failed to extract HGVS notation from query");
  }
}

// Function to lookup genomic coordinates
async function lookupGenomicCoordinates(hgvs) {
  try {
    console.log(`Looking up genomic coordinates for ${hgvs}`);
    
    // Use Ensembl variant_recoder API to get variant information including genomic coordinates
    const ensemblUrl = `https://rest.ensembl.org/variant_recoder/human/${encodeURIComponent(hgvs)}`;
    const response = await fetch(ensemblUrl, {
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json"
      }
    });
    
    if (!response.ok) {
      throw new Error(`Ensembl API returned ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    return {
      chromosome: data.seq_region_name,
      start: data.start,
      end: data.end,
      assembly: data.assembly_name,
      strand: data.strand
    };
  } catch (error) {
    console.error("Error looking up genomic coordinates:", error);
    throw new Error(`Failed to lookup genomic coordinates: ${error.message}`);
  }
}

// Function to query UCSC Genome Browser API
async function queryUCSCGenomeBrowser(coordinates) {
  try {
    console.log(`Querying UCSC Genome Browser for ${JSON.stringify(coordinates)}`);
    
    // Generate UCSC Genome Browser URL
    const browserUrl = `https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38&position=chr${coordinates.chromosome}:${coordinates.start}-${coordinates.end}`;
    
    // For UCSC data, we would typically use their API
    // Since direct API access may be limited, we'll return the browser URL
    // which can be used to view the region
    return {
      tracks: ["refGene", "conservation", "regulation"],
      browserUrl
    };
  } catch (error) {
    console.error("Error querying UCSC Genome Browser:", error);
    throw new Error("Failed to query UCSC Genome Browser");
  }
}

// Function to find gene region, conservation scores, etc.
async function findGeneData(coordinates) {
  try {
    console.log(`Finding gene data for ${JSON.stringify(coordinates)}`);
    
    // Use Ensembl REST API to get gene data
    const overlappingFeaturesUrl = `https://rest.ensembl.org/overlap/region/human/${coordinates.chromosome}:${coordinates.start}-${coordinates.end}?feature=gene;feature=transcript;feature=exon`;
    const featuresResponse = await fetch(overlappingFeaturesUrl, {
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      }
    });
    
    if (!featuresResponse.ok) {
      throw new Error(`Ensembl API returned ${featuresResponse.status}: ${featuresResponse.statusText}`);
    }
    
    const featuresData = await featuresResponse.json();
    
    // Process gene data
    const genes = featuresData.filter(feature => feature.feature_type === 'gene');
    const transcripts = featuresData.filter(feature => feature.feature_type === 'transcript');
    const exons = featuresData.filter(feature => feature.feature_type === 'exon');
    
    return {
      geneRegion: {
        genes: genes.map(gene => ({
          id: gene.id,
          name: gene.external_name,
          biotype: gene.biotype,
          strand: gene.strand
        })),
        transcripts: transcripts.map(transcript => transcript.id),
        exons: exons.length
      },
      // Simplified response to avoid additional API calls
      conservationScores: "Data available via Ensembl",
      regulatoryOverlaps: "Data available via Ensembl",
      knownSNPs: "Data available via Ensembl"
    };
  } catch (error) {
    console.error("Error finding gene data:", error);
    throw new Error(`Failed to find gene data: ${error.message}`);
  }
}

// Function to get ClinVar or dbSNP annotations
async function getVariantAnnotations(hgvs) {
  try {
    console.log(`Getting variant annotations for ${hgvs}`);
    
    // Use Ensembl VEP API to get variant annotations
    const vepUrl = `https://rest.ensembl.org/vep/human/hgvs/${encodeURIComponent(hgvs)}`;
    const vepResponse = await fetch(vepUrl, {
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      }
    });
    
    if (!vepResponse.ok) {
      throw new Error(`Ensembl VEP API returned ${vepResponse.status}: ${vepResponse.statusText}`);
    }
    
    const vepData = await vepResponse.json();
    
    return {
      vep: vepData,
      clinvar: "Data available via ClinVar"
    };
  } catch (error) {
    console.error("Error getting variant annotations:", error);
    throw new Error(`Failed to get variant annotations: ${error.message}`);
  }
}

// Main function to explore variant phenotypes
async function variantToPhenotypeExploration(variant) {
  try {
    console.log("Processing variant query:", variant);
    
    // Step 1: Extract HGVS notation from the query using LLM
    // This is the key step where we use LLM to extract just the HGVS notation
    const hgvsNotation = await extractHGVSFromQuery(variant);
    console.log("Extracted HGVS notation:", hgvsNotation);
    
    // If we can't get a valid HGVS notation, we can't proceed
    if (!hgvsNotation) {
      throw new Error("Failed to extract valid HGVS notation from query");
    }
    
    // Step 2: Perform genomic coordinate lookup via UCSC or Ensembl REST
    const genomicCoordinates = await lookupGenomicCoordinates(hgvsNotation);
    
    // Step 3: Query UCSC Genome Browser API
    const ucscData = await queryUCSCGenomeBrowser(genomicCoordinates);
    
    // Step 4: Find gene region, conservation scores, regulatory overlaps, known SNPs
    const geneData = await findGeneData(genomicCoordinates);
    
    // Step 5: Get ClinVar or dbSNP annotations
    const variantAnnotations = await getVariantAnnotations(hgvsNotation);
    
    // Return all the details as requested
    return {
      hgvsNotation, // This is the HGVS notation extracted by the LLM
      genomicCoordinates, // Genomic coordinates from lookup
      ucscData, // UCSC Genome Browser data
      geneData, // Gene region, conservation scores, regulatory overlaps, known SNPs
      variantAnnotations // ClinVar or dbSNP annotations
    };
  } catch (error) {
    console.error("Error in variant to phenotype exploration:", error);
    return {
      error: "Failed to process variant information",
      details: error.message,
      hgvsNotation: variant // Return the original query if extraction failed
    };
  }
}

// Register the tool
server.tool(
  "variantToPhenotypeExploration",
  { query: z.string() },
  async ({ query }) => ({
    content: [{
      type: "text",
      text: JSON.stringify(await variantToPhenotypeExploration(query))
    }]
  })
);

// Start the server
async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
